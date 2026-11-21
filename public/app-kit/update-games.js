// Claudix: кладёт свежие игры внутрь приложения.
// Скачивает страницы с сайта, вшивает в каждую все её скрипты (three.js, язык, аккаунты)
// и сохраняет в папку games/ — дальше приложение работает с ними без сайта и без интернета.
// Запуск в папке проекта: node update-games.js
const fs = require("fs");
const path = require("path");

const SITE = process.env.CLAUDIX_SITE || "https://claudix.aoyt.workers.dev";
const PAGES = { index: "/", liga: "/liga", lemon: "/lemon", viraj: "/viraj", books: "/books", privacy: "/privacy" };
const OUT = path.join(__dirname, "games");

async function get(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.text();
}

async function bundle(name, route) {
  let html = await get(SITE + route);
  // все <script src="..."></script> заменяем на сам код скрипта
  const tags = [...html.matchAll(/<script([^>]*)\ssrc="([^"]+)"([^>]*)><\/script>/g)];
  for (const m of tags) {
    const src = m[2], url = /^https?:/.test(src) ? src : SITE + "/" + src.replace(/^\.?\//, "");
    const code = (await get(url)).replace(/<\/script/gi, "<\\/script");
    html = html.replace(m[0], () => "<script>" + code + "</script>");
  }
  // метка «я внутри приложения» — до всех остальных скриптов
  html = html.replace(/<meta charset="utf-8">/i, (t) => t + "<script>window.CLAUDIX_APP=1</script>");
  // в приложении не нужны манифест и подсказки для установки сайта
  html = html.replace(/<link rel="manifest"[^>]*>/, "");
  fs.writeFileSync(path.join(OUT, "page-" + name + ".js"), "export default " + JSON.stringify(html) + ";\n");
  return Math.round(html.length / 1024);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, route] of Object.entries(PAGES)) {
    const kb = await bundle(name, route);
    console.log("✓ " + name + " (" + kb + " КБ)");
  }
  const names = Object.keys(PAGES);
  fs.writeFileSync(path.join(OUT, "index.js"),
    names.map((n) => "import " + n + " from './page-" + n + "';").join("\n") + "\nexport default { " + names.join(", ") + " };\n");
  console.log("Готово: игры лежат в папке games/");
})().catch((e) => { console.error("Ошибка:", e.message); process.exit(1); });
