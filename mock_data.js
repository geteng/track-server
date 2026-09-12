/**
 * Mock 数据生成脚本
 * 生成约 300 条真实模拟埋点数据，覆盖 4 个应用、9 种事件、20 个用户
 * 用法: node mock_data.js
 */
const sqlite3 = require('sqlite3').verbose();
const dataLevels = require('./data-levels');
const db = new sqlite3.Database('./track.db');

const apps = ['airDemo5', 'airDemo_xi', 'airDemo_cjy', 'airDemo4'];
const pages = ['home', 'tryon', 'customize', 'mine'];
const lookNames = ['通勤穿搭', '约会穿搭', '旅行穿搭'];
const noteTitles = ['我保证我是天使', '淡人韩系穿搭', '一周穿搭不重样'];

const eventTemplates = [
  { event: 'page_view',       extraFn: () => ({ page: pages[Math.floor(Math.random() * pages.length)] }) },
  { event: 'btn_click_tryon', extraFn: () => ({ buttonId: 'try-on-btn', section: 'home' }) },
  { event: 'btn_click_customize', extraFn: () => ({ buttonId: 'customize-btn', section: 'home' }) },
  { event: 'btn_click_note',  extraFn: () => ({ noteId: Math.floor(Math.random() * 3) + 1, title: noteTitles[Math.floor(Math.random() * 3)] }) },
  { event: 'btn_click_look',  extraFn: () => ({ lookId: Math.floor(Math.random() * 3) + 1, lookName: lookNames[Math.floor(Math.random() * 3)] }) },
  { event: 'tab_switch',      extraFn: () => ({ from: pages[Math.floor(Math.random() * 4)], to: pages[Math.floor(Math.random() * 4)] }) },
  { event: 'swipe_look',      extraFn: () => ({ lookId: Math.floor(Math.random() * 3) + 1, direction: Math.random() > 0.5 ? 'left' : 'right' }) },
  { event: 'leave_page',      extraFn: () => ({ duration: Math.floor(Math.random() * 120000) + 5000 }) },
  { event: 'share_click',     extraFn: () => ({ contentType: Math.random() > 0.5 ? 'look' : 'note', contentId: Math.floor(Math.random() * 3) + 1 }) },
];

const uaList = [
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', screen: '390x844' },
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', screen: '375x812' },
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', screen: '414x896' },
  { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36', screen: '412x915' },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', screen: '360x800' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', screen: '1920x1080' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', screen: '1920x1080' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', screen: '1440x900' },
];

// 生成 20 个匿名用户ID
const users = Array.from({ length: 20 }, () => {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
});

// 生成模拟用户会话序列（每个用户 5~20 条记录，模拟真实浏览路径）
const now = Date.now();
const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
const records = [];

users.forEach((userId, userIdx) => {
  // 每个用户 5~20 条记录
  const sessionCount = Math.floor(Math.random() * 16) + 5;
  
  for (let s = 0; s < sessionCount; s++) {
    // 随机选择一个时间点（偏向近期）
    const timeBias = Math.pow(Math.random(), 1.5);
    const sessionStart = Math.floor(sevenDaysAgo + timeBias * (now - sevenDaysAgo));
    
    // 每个会话 3~8 个连续行为
    const actionCount = Math.floor(Math.random() * 6) + 3;
    const app = apps[Math.floor(Math.random() * apps.length)];
    const uaObj = uaList[Math.floor(Math.random() * uaList.length)];
    let currentTime = sessionStart;
    
    for (let a = 0; a < actionCount; a++) {
      // 第一个行为通常是 page_view
      const eventIdx = a === 0 ? 0 : Math.floor(Math.random() * eventTemplates.length);
      const eventObj = eventTemplates[eventIdx];
      
      const url = `https://gtt666.cn/${app}/`;
      const referrer = a === 0
        ? (Math.random() > 0.5 ? 'https://www.xiaohongshu.com/' : '')
        : `https://gtt666.cn/${app}/`;
      
      records.push({
        aid: userId,
        event: eventObj.event,
        url,
        referrer,
        timestamp: currentTime,
        userAgent: uaObj.ua,
        screen: uaObj.screen,
        extra: JSON.stringify(eventObj.extraFn())
      });
      
      // 下一个行为间隔 2~60 秒
      currentTime += Math.floor(Math.random() * 58000) + 2000;
      if (currentTime > now) currentTime = now - Math.floor(Math.random() * 60000);
    }
  }
});

// 按时间排序
records.sort((a, b) => a.timestamp - b.timestamp);

console.log(`准备插入 ${records.length} 条 mock 数据...`);

// 清理旧 mock 数据并插入新数据
db.serialize(() => {
  db.run("DELETE FROM behavior_log WHERE aid IN ('" + users.join("','") + "')", (err) => {
    if (err) {
      console.error('清理旧数据失败:', err.message);
    } else {
      console.log('已清理旧 mock 数据');
    }

    const insertSql = `INSERT INTO behavior_log (aid, event, url, referrer, timestamp, userAgent, screen, level, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    let completed = 0;
    const total = records.length;
    
    records.forEach(record => {
      db.run(insertSql, [
        record.aid, record.event, record.url, record.referrer,
        record.timestamp, record.userAgent, record.screen,
        dataLevels.levelOf(record.event), record.extra
      ], (err) => {
        completed++;
        if (err) {
          console.error(`插入失败 (${completed}/${total}):`, err.message);
        }
        if (completed === total) {
          console.log(`✅ 成功插入 ${total} 条 mock 数据`);
          // 验证
          db.get('SELECT COUNT(*) as count FROM behavior_log', (err, row) => {
            if (!err) console.log(`数据库总记录数: ${row.count}`);
            db.close();
          });
        }
      });
    });
  });
});
