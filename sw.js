// sw.js - 这是专门给安卓系统处理通知的后台文件
self.addEventListener('install', (e) => {
    console.log('Service Worker 已安装');
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('Service Worker 已激活');
    e.waitUntil(self.clients.claim());
});

// 监听通知点击事件
self.addEventListener('notificationclick', (event) => {
    event.notification.close(); // 点击后关闭通知
    // 尝试打开或聚焦到日记本页面
    event.waitUntil(
        clients.matchAll({type: 'window'}).then((clientList) => {
            for (const client of clientList) {
                if (client.url === '/' && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});
