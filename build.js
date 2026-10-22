// Собирает один самодостаточный HTML-файл (dist/algo-visualizer.html):
// стили и скрипты встраиваются внутрь. Удобно, чтобы отправить кому-то один файл.
//   node build.js
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const html = read('index.html');

const between = (s, a, b) => {
  const i = s.indexOf(a), j = s.indexOf(b);
  if (i < 0 || j < 0) throw new Error('Не найдены метки ' + a + ' / ' + b);
  return s.slice(i + a.length, j);
};

const head = between(html, '<!-- ARTIFACT-HEAD-START -->', '<!-- ARTIFACT-HEAD-END -->')
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + read('styles.css') + '\n</style>');
const body = between(html, '<!-- ARTIFACT-BODY-START -->', '<!-- ARTIFACT-BODY-END -->')
  .replace('<script src="engine.js"></script>', () => '<script>\n' + read('engine.js') + '\n</script>')
  .replace('<script src="examples.js"></script>', () => '<script>\n' + read('examples.js') + '\n</script>')
  .replace('<script src="app.js"></script>', () => '<script>\n' + read('app.js') + '\n</script>');

// Фрагмент без <html>/<head>/<body> — для публикации как артефакт
const fragment = head.trim() + '\n' + body.trim() + '\n';
// Полноценная страница — открывается двойным кликом
const full = '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  head.trim() + '\n</head>\n<body>\n' + body.trim() + '\n</body>\n</html>\n';

fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist', 'algo-visualizer.html'), full);
fs.writeFileSync(path.join(dir, 'dist', 'artifact.html'), fragment);
console.log('Готово: dist/algo-visualizer.html');
