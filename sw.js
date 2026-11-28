// 应用壳离线缓存：首页网络优先并带超时回退，其余同源资源缓存优先、后台更新
var CACHE = 'yuc-ln-shell-v68';
// 索引包（pyf/rpy/au）故意不进预缓存：它们是按需加载的，进 SHELL 会让首次安装多下 152KB。
// opencc 是搜索归一化的依赖，页面一打开就请求，所以放进预缓存保证离线时搜索仍然可用。
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './vendor/opencc-t2cn.js', './data/light-novels-lite.js', './data/light-novels-extra.js', './data/light-novels-ch.js'];
var IMG_LIMIT = 400;

// 判断「这条缓存是不是封面」**只有这一条正则**。
//
// 这里原本还写着 `req.destination === 'image' || ...`，但前半个条件在这条路径上
// 恒为假：cache.keys() 返回的不是当初存进去的那个 Request，而是从缓存条目重建的，
// 只保留 url / method / headers / mode —— destination 一律是空串。
// 实测（scripts/probe-cache-dest.mjs）：同源脚本、bgmimg 封面、ranobedb 封面
// 三类读回来全是 "destination": ""，命中情况 0 / 1 / 1，全部只靠正则。
// 所以那个条件是装饰品，删掉不影响行为，但留着会误导：「destination 能兜底」
// 这个印象一旦成立，将来新增图源时就不会去改正则，那些封面永远进不了回收范围，
// 缓存一路涨到配额满，而表面上看不出来。
// 注意区分：下面 fetch 事件里的 `req.destination === 'image'` 拿到的是原始请求，
// 那个是真的有效，和这里不是一回事。
// 判据是 URL 主机名，改图源必须改这里（index.html 的 IMG_CACHE_RE 要一起改，
// 那个管的是设置面板里「封面 N 张」的计数）。
var IMG_RE = /bgmimg|anibt|ranobedb/;

// 封面缓存有上限：超出后按插入顺序清理最旧的，避免长期使用占满配额
function trimImageCache(cache) {
  return cache.keys().then(function (keys) {
    var imgs = keys.filter(function (req) {
      return IMG_RE.test(req.url);
    });
    if (imgs.length <= IMG_LIMIT) return null;
    var drop = imgs.slice(0, imgs.length - IMG_LIMIT);
    return Promise.all(drop.map(function (req) { return cache.delete(req); }));
  }).catch(function () {});
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 强制走网络，避免 HTTP 缓存让新版本壳继续用旧文件
      return cache.addAll(SHELL.map(function (url) {
        return new Request(url, { cache: 'reload' });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // 同源可能还部署着番剧等项目，只清理本项目前缀的旧缓存
      return Promise.all(keys.map(function (key) {
        if (key === CACHE) return null;
        if (key.indexOf('yuc-ln-') !== 0) return null;
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // 封面等图片：缓存优先，命中直接返回，未命中走网络并写入缓存
  if (req.destination === 'image') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          // 封面多为跨域 opaque 响应（status 0），同样可以缓存供离线使用
          if (res.ok || res.type === 'opaque') {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) {
              return cache.put(req, copy).then(function () { return trimImageCache(cache); });
            });
          }
          return res;
        });
      })
    );
    return;
  }

  var url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

  // 页面本身：网络优先；1.5s 内没回来就先展示缓存，等下次启动再用新版
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        }).catch(function () {
          return hit || caches.match('./index.html');
        });
        if (!hit) return net;
        var timer = new Promise(function (resolve) {
          setTimeout(function () { resolve(hit); }, 1500);
        });
        return Promise.race([net, timer]);
      })
    );
    return;
  }

  // 数据与静态资源：立即用缓存，后台拉新版本供下次使用
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;
      });
      return hit || net;
    })
  );
});


