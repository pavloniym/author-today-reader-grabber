const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const https = require('https');
const crypto = require('crypto');

class AuthorTodayGrabber {
    constructor() {
        this.cookies = this.loadCookies();
        this.browser = null;
        this.page = null;
        this.booksDir = './books';
        this.ensureBooksDirectory();
    }

    ensureBooksDirectory() {
        if (!fs.existsSync(this.booksDir)) {
            fs.mkdirSync(this.booksDir, { recursive: true });
        }
    }

    loadCookies() {
        try {
            if (fs.existsSync('cookies.json')) {
                return JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
            }
        } catch (err) {
            console.log('Не удалось загрузить cookies:', err.message);
        }
        return [];
    }

    async init() {
        this.browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        this.page = await this.browser.newPage();

        // Устанавливаем cookies
        if (this.cookies.length > 0) {
            await this.page.setCookie(...this.cookies);
        }

        // Имитируем реальный браузер
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await this.page.setViewport({ width: 1920, height: 1080 });
    }

    async parseBookData(url) {
        console.log('Загружаем страницу книги...');
        await this.page.goto(url, { waitUntil: 'networkidle2' });

        // Ждем загрузки данных
        await this.page.waitForSelector('.book-title, h1', { timeout: 10000 });

        const bookData = await this.page.evaluate(() => {
            // Извлекаем базовую информацию
            const title = document.querySelector('.book-title')?.textContent?.trim() ||
                document.querySelector('h1')?.textContent?.trim() || 'Неизвестное название';

            const author = document.querySelector('.book-author a')?.textContent?.trim() || 'Неизвестный автор';

            const genres = Array.from(document.querySelectorAll('a[href*="/work/genre/"]'))
                .map(a => a.textContent.trim())
                .filter(g => g && g !== 'Роман');

            const annotation = document.querySelector('meta[property="og:description"]')?.content ||
                document.querySelector('meta[name="description"]')?.content || '';

            // Обложка
            const coverUrl = document.querySelector('meta[property="og:image"]')?.content ||
                document.querySelector('.cover-image')?.src || '';

            // Дополнительные метаданные
            const seriesInfo = document.querySelector('a[href*="/work/series/"]')?.textContent?.trim() || '';
            const publishDate = document.querySelector('[data-format="calendar"]')?.getAttribute('data-time') || new Date().toISOString();
            const size = document.querySelector('.hint-top')?.textContent?.trim() || '';

            // Теги
            const tags = Array.from(document.querySelectorAll('.tags a'))
                .map(a => a.textContent.trim())
                .filter(tag => tag);

            // Извлекаем список глав из JS
            const chaptersMatch = document.documentElement.outerHTML.match(/chapters:\s*(\[.*?\])/s);
            let chapters = [];

            if (chaptersMatch) {
                try {
                    chapters = JSON.parse(chaptersMatch[1]);
                } catch (e) {
                    console.error('Ошибка парсинга глав:', e);
                }
            }

            return {
                title,
                author,
                genres,
                annotation,
                chapters,
                coverUrl,
                seriesInfo,
                publishDate,
                size,
                tags
            };
        });

        console.log(`Найдена книга: "${bookData.title}" от ${bookData.author}`);
        console.log(`Глав найдено: ${bookData.chapters.length}`);

        return bookData;
    }

    async grabChapterContent(baseUrl, chapterId) {
        const chapterUrl = baseUrl.replace(/\/\d+$/, `/${chapterId}`);

        try {
            await this.page.goto(chapterUrl, { waitUntil: 'networkidle2' });

            // Ждем загрузки контента
            await this.page.waitForSelector('#text-container', { timeout: 15000 });

            // Ждем, пока контент действительно загрузится
            await this.page.waitForFunction(() => {
                const container = document.querySelector('#text-container');
                return container && container.textContent.trim().length > 100;
            }, { timeout: 10000 });

            const content = await this.page.evaluate(() => {
                const container = document.querySelector('#text-container');
                if (!container) return '';

                // Преобразуем HTML в простой текст с сохранением структуры
                const processNode = (node) => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return node.textContent;
                    }

                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const tag = node.tagName.toLowerCase();
                        let text = '';

                        // Обрабатываем параграфы
                        if (tag === 'p' || tag === 'div') {
                            for (const child of node.childNodes) {
                                text += processNode(child);
                            }
                            return text.trim() ? `<p>${text.trim()}</p>` : '';
                        }

                        // Обрабатываем переносы строк
                        if (tag === 'br') {
                            return '\n';
                        }

                        // Обрабатываем курсив и жирный текст
                        if (tag === 'i' || tag === 'em') {
                            for (const child of node.childNodes) {
                                text += processNode(child);
                            }
                            return text ? `<emphasis>${text}</emphasis>` : '';
                        }

                        if (tag === 'b' || tag === 'strong') {
                            for (const child of node.childNodes) {
                                text += processNode(child);
                            }
                            return text ? `<strong>${text}</strong>` : '';
                        }

                        // Для остальных тегов просто извлекаем содержимое
                        for (const child of node.childNodes) {
                            text += processNode(child);
                        }

                        return text;
                    }

                    return '';
                };

                let result = processNode(container);

                // Очищаем и форматируем результат
                result = result.replace(/<p>\s*<\/p>/g, ''); // удаляем пустые параграфы
                result = result.replace(/\n\s*\n/g, '\n'); // убираем множественные переносы

                // Если нет параграфов, создаем их из текста
                if (!result.includes('<p>')) {
                    result = result.split(/\n\s*\n/)
                        .filter(p => p.trim())
                        .map(p => `<p>${p.trim()}</p>`)
                        .join('\n');
                }

                return result.trim();
            });

            return content;

        } catch (error) {
            console.error(`Ошибка при загрузке главы ${chapterId}:`, error.message);
            return '';
        }
    }

    async downloadCover(coverUrl, bookTitle) {
        if (!coverUrl) return null;

        try {
            console.log('Скачиваем обложку...');
            const fileName = this.generateSafeFileName(bookTitle) + '_cover.jpg';
            const filePath = path.join(this.booksDir, fileName);

            return new Promise((resolve, reject) => {
                const file = fs.createWriteStream(filePath);

                https.get(coverUrl, (response) => {
                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        // Читаем файл в base64
                        const coverData = fs.readFileSync(filePath);
                        const base64Cover = coverData.toString('base64');

                        resolve({
                            fileName,
                            data: base64Cover,
                            contentType: 'image/jpeg'
                        });
                    });
                }).on('error', (err) => {
                    fs.unlink(filePath, () => {});
                    reject(err);
                });
            });
        } catch (error) {
            console.error('Ошибка при скачивании обложки:', error.message);
            return null;
        }
    }

    generateSafeFileName(title) {
        return title
            .replace(/[<>:"/\\|?*]/g, '') // удаляем недопустимые символы
            .replace(/\s+/g, '_') // пробелы в подчеркивания
            .substring(0, 100); // ограничиваем длину
    }

    mapGenreToFB2(genres) {
        const genreMap = {
            'Мистика': 'sf_horror',
            'Городское фэнтези': 'sf_fantasy',
            'Юмористическое фэнтези': 'humor_fantasy',
            'Фэнтези': 'sf_fantasy',
            'Любовные романы': 'love_contemporary',
            'Романтическое фэнтези': 'love_fantasy',
            'Детектив': 'detective',
            'Триллер': 'thriller',
            'Приключения': 'adventure',
            'Историческая проза': 'prose_history',
            'Современная проза': 'prose_contemporary'
        };

        if (genres.length === 0) return 'prose_contemporary';

        const firstGenre = genres[0];
        return genreMap[firstGenre] || 'prose_contemporary';
    }

    escapeXml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    generateFB2(bookData, chapters, coverData = null) {
        const now = new Date().toISOString().split('T')[0];
        const publishDate = bookData.publishDate ? new Date(bookData.publishDate).toISOString().split('T')[0] : now;

        const safeTitle = this.escapeXml(bookData.title);
        const safeAuthor = this.escapeXml(bookData.author);
        const safeAnnotation = this.escapeXml(bookData.annotation);
        const safeSeries = bookData.seriesInfo ? this.escapeXml(bookData.seriesInfo) : '';

        // Разделяем автора на имя и фамилию
        const authorParts = bookData.author.split(' ');
        const firstName = authorParts[0] || 'Неизвестное';
        const lastName = authorParts.slice(1).join(' ') || 'Имя';

        const genre = this.mapGenreToFB2(bookData.genres);
        const keywords = [...bookData.genres, ...bookData.tags].join(', ');

        let fb2Content = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>${genre}</genre>
<author>
<first-name>${this.escapeXml(firstName)}</first-name>
<last-name>${this.escapeXml(lastName)}</last-name>
</author>
<book-title>${safeTitle}</book-title>`;

        if (safeSeries) {
            fb2Content += `
<sequence name="${safeSeries}" number="1"/>`;
        }

        fb2Content += `
<annotation>
<p>${safeAnnotation}</p>
</annotation>
<keywords>${this.escapeXml(keywords)}</keywords>
<date value="${publishDate}">${publishDate}</date>
<coverpage>`;

        if (coverData) {
            fb2Content += `
<image l:href="#cover.jpg"/>`;
        }

        fb2Content += `
</coverpage>
<lang>ru</lang>
<src-lang>ru</src-lang>
</title-info>
<document-info>
<author>
<nickname>Author.Today Grabber</nickname>
</author>
<program-used>Author.Today Grabber v1.0</program-used>
<date value="${now}">${now}</date>
<src-url>Author.Today</src-url>
<version>1.0</version>
<history>
<p>Скачано с Author.Today</p>
</history>
</document-info>
<publish-info>
<publisher>Author.Today</publisher>
<year>${publishDate.split('-')[0]}</year>
</publish-info>
</description>`;

        // Добавляем обложку в бинарные данные
        if (coverData) {
            fb2Content += `
<binary id="cover.jpg" content-type="${coverData.contentType}">
${coverData.data}
</binary>`;
        }

        fb2Content += `
<body>`;

        if (safeTitle) {
            fb2Content += `
<title>
<p>${safeTitle}</p>
</title>`;
        }

        chapters.forEach((chapter, index) => {
            const safeChapterTitle = this.escapeXml(chapter.title || `Глава ${index + 1}`);

            fb2Content += `
<section>
<title>
<p>${safeChapterTitle}</p>
</title>
${chapter.content || '<p>Содержимое главы не загружено</p>'}
</section>`;
        });

        fb2Content += `
</body>
</FictionBook>`;

        return fb2Content;
    }

    async grabBook(url) {
        try {
            await this.init();

            // Извлекаем данные о книге
            const bookData = await this.parseBookData(url);

            if (!bookData.chapters || bookData.chapters.length === 0) {
                throw new Error('Не найдены главы книги');
            }

            // Скачиваем обложку
            const coverData = await this.downloadCover(bookData.coverUrl, bookData.title);

            // Загружаем содержимое каждой главы (только первые 2 для тестов)
            const chaptersWithContent = [];
            //const chaptersToProcess = bookData.chapters.slice(0, 2);
            const chaptersToProcess = bookData.chapters;


            for (let i = 0; i < chaptersToProcess.length; i++) {
                const chapter = chaptersToProcess[i];
                console.log(`Загружаем главу ${i + 1}/${chaptersToProcess.length}: ${chapter.title}`);

                const content = await this.grabChapterContent(url, chapter.id);

                chaptersWithContent.push({
                    title: chapter.title,
                    content: content
                });

                // Небольшая задержка между запросами
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Генерируем FB2
            const fb2Content = this.generateFB2(bookData, chaptersWithContent, coverData);

            // Автоматически генерируем имя файла
            const safeFileName = this.generateSafeFileName(bookData.title) + '.fb2';
            const filePath = path.join(this.booksDir, safeFileName);

            fs.writeFileSync(filePath, fb2Content, 'utf8');

            console.log(`Книга сохранена в файл: ${filePath}`);
            console.log(`Автор: ${bookData.author}`);
            console.log(`Жанры: ${bookData.genres.join(', ')}`);
            console.log(`Серия: ${bookData.seriesInfo || 'Не указана'}`);
            console.log(`Обложка: ${coverData ? 'Добавлена' : 'Не найдена'}`);

            return filePath;

        } catch (error) {
            console.error('Ошибка при парсинге книги:', error);
            throw error;
        } finally {
            if (this.browser) {
                await this.browser.close();
            }
        }
    }
}

// Использование
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Использование: node grabber.js <URL>');
        console.log('Пример: node grabber.js https://author.today/reader/276663/2504663');
        return;
    }

    const url = args[0];
    const grabber = new AuthorTodayGrabber();

    try {
        await grabber.grabBook(url);
        console.log('Парсинг завершен успешно!');
    } catch (error) {
        console.error('Ошибка:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = AuthorTodayGrabber;