const Database = require('sqlite3').verbose().Database;
const http = require('http');
const db = new Database('/home/ubuntu/h5-track-server/track.db');

db.serialize(() => {
  db.all('PRAGMA table_info(behavior_log)', (e, cols) => {
    console.log('COLUMNS=' + JSON.stringify((cols || []).map(c => c.name)));
    const samples = [
      { aid: 'airDemo5',   uid: 'user_1001', event: 'page_view',        url: 'https://gtt666.cn/airDemo5/',   eventMsg: '访问首页',             extra: { page: 'home' } },
      { aid: 'airDemo_cjy', uid: '',          event: 'btn_click_tryon',  url: 'https://gtt666.cn/airDemo_cjy/', eventMsg: '点击「试穿」按钮',     extra: { buttonId: 'try-on' } },
      { aid: 'airDemo_xi',  uid: 'user_2002', event: 'share_click',      url: 'https://gtt666.cn/airDemo_xi/',  eventMsg: '分享穿搭(ID:3)',       extra: { contentType: 'look', contentId: 3 } }
    ];
    let done = 0;
    samples.forEach(s => {
      const data = JSON.stringify(s);
      const req = http.request({
        host: '127.0.0.1', port: 3000, path: '/api/track', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          console.log('TRACK ' + s.event + ' uid=' + s.uid + ' => ' + body);
          if (++done === samples.length) { console.log('DONE_SENDING'); process.exit(0); }
        });
      });
      req.on('error', err => { console.log('REQ_ERR ' + err.message); if (++done === samples.length) process.exit(1); });
      req.write(data); req.end();
    });
  });
});
