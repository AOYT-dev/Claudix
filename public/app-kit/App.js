// Claudix: игры лежат внутри приложения (папка games/), сайт для игры не нужен.
// Сервер используется только для аккаунта, облачных сохранений и онлайн-режима.
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';
import GAMES from './games';

const HOST = 'claudix.aoyt.workers.dev';
const BASE = 'https://' + HOST + '/';

// адрес → какая страница из games/ (или null, если это чужой сайт)
function pageOf(url) {
  const m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/.exec(url || '');
  if (!m || m[1] !== HOST) return null;
  let p = (m[2] || '/').replace(/\/\.\//g, '/').replace(/^\//, '').replace(/\.html$/, '').replace(/\/$/, '');
  if (p === '' || p === 'index') p = 'index';
  return GAMES[p] ? p : null;
}
const urlOf = (page) => BASE + (page === 'index' ? '' : page);
const noHash = (u) => (u || '').split('#')[0];

export default function App() {
  const [page, setPage] = useState('index');
  const [n, setN] = useState(0); // увеличиваем, чтобы перезагрузить страницу
  const loading = useRef(true);

  function open(p) { loading.current = true; setPage(p); setN((x) => x + 1); }

  // Android: кнопка «Назад» возвращает на главную
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page !== 'index') { open('index'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [page]);

  function onShouldStart(req) {
    const url = req.url || '';
    if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) return true;
    const p = pageOf(url);
    if (!p) {
      if (/^(https?|mailto|tel):/.test(url)) Linking.openURL(url).catch(() => {});
      return false;
    }
    // первая загрузка страницы и переходы по #якорям внутри неё
    if (p === page && (loading.current || noHash(url) === noHash(urlOf(page)) && url.includes('#'))) return true;
    // другая страница Claudix или location.reload(): берём её из games/
    open(p);
    return false;
  }

  return (
    <>
      <StatusBar hidden />
      <WebView
        key={n}
        originWhitelist={['*']}
        source={{ html: GAMES[page], baseUrl: urlOf(page) }}
        onShouldStartLoadWithRequest={onShouldStart}
        onLoadEnd={() => { loading.current = false; }}
        style={{ flex: 1, backgroundColor: '#11141b' }}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        domStorageEnabled
        javaScriptEnabled
        setSupportMultipleWindows={false}
      />
    </>
  );
}
