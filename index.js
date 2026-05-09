const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

const app = express();

// [Cloud Adaptation] Priority to platform port (Render uses 10000 by default)
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static file service for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ⚠️ SiliconFlow API Key
const SILICON_API_KEY = "sk-xtfxbevwghsfahueuppeargbpzeryhtphecpscpmrhxyhmiu"; 

// [Cloud Adaptation] Database connection pool for Aiven MySQL
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '123456',
    database: process.env.MYSQL_DATABASE || 'campus_trade',
    port: process.env.MYSQL_PORT || 3306,
    timezone: '+08:00',
    // SSL is mandatory for Aiven
    ssl: process.env.MYSQL_HOST ? { rejectUnauthorized: false } : null,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ================= Diagnostic Routes =================

// 1. Home Welcome Page
app.get('/', (req, res) => {
    res.send(`
        <div style="text-align:center;padding-top:50px;font-family:sans-serif;">
            <h1 style="color:#6B4EFF;">🚀 校乐淘后端服务已成功启动</h1>
            <p>当前环境：Render 云端</p>
            <p>API 根路径：<a href="/api/goods">/api/goods</a></p>
            <div style="color:green;margin-top:20px;">状态：运行中 (Running)</div>
        </div>
    `);
});

// 2. Database Health Check
app.get('/debug/db', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT 1 + 1 AS result');
        res.json({ status: 'success', message: '数据库连接正常', data: rows });
    } catch (err) {
        res.json({ status: 'error', message: '数据库连接失败', detail: err.message });
    }
});

// ================= API Implementation =================

// --- AI Chat Agent (Bargaining Logic) ---
app.post('/api/chat/reply', async (req, res) => {
    const { productName, price, history } = req.body;
    try {
        const currentPrice = Number(price);
        const minPrice = (currentPrice * 0.8).toFixed(2); // 80% discount limit

        const messages = [
            { 
                role: "system", 
                content: `你是校园二手交易平台的真实卖家。你正在卖【${productName}】，标价【${currentPrice}元】。
                底价是【${minPrice}元】。
                1. 语气随和、大学生化。
                2. 只有最终同意成交时，才在句末加 ##价格## 暗号。
                3. 不要暴露底价规则给用户。`
            }
        ];

        if (history && history.length > 0) {
            history.slice(-8).forEach(msg => {
                messages.push({ role: msg.isMe ? "user" : "assistant", content: msg.content });
            });
        }

        const response = await axios.post('https://api.siliconflow.cn/v1/chat/completions', {
            model: "Qwen/Qwen2.5-7B-Instruct",
            messages: messages,
            max_tokens: 150,
            temperature: 0.7 
        }, {
            headers: { 'Authorization': `Bearer ${SILICON_API_KEY}` },
            httpsAgent: new https.Agent({ family: 4 }) 
        });

        res.json({ code: 0, data: response.data.choices[0].message.content });
    } catch (err) {
        res.json({ code: 0, data: "宝子，学校网有点卡..." });
    }
});

// --- Goods Management ---
app.get('/api/goods', async (req, res) => {
    try {
        const { keyword, id, status, userId } = req.query;
        let sql = 'SELECT g.*, u.avatar as user_avatar, u.nickname as seller_nick FROM goods g LEFT JOIN users u ON g.user_id = u.id WHERE 1=1';
        let params = [];
        if (id) { sql += ' AND g.id = ?'; params.push(id); }
        if (status) { sql += ' AND g.status = ?'; params.push(status); }
        else if (!id) { sql += ' AND g.status != 3'; } // Hide deleted
        if (userId) { sql += ' AND g.user_id = ?'; params.push(userId); }
        if (keyword) { sql += ' AND g.title LIKE ?'; params.push(`%${keyword}%`); }
        sql += ' ORDER BY g.create_time DESC';
        const [rows] = await pool.execute(sql, params);
        res.json({ code: 0, data: rows });
    } catch (e) { res.status(500).json({ code: 500, error: e.message }); }
});

app.post('/api/goods', async (req, res) => {
    try {
        const { title, price, desc, image, userId, userName } = req.body;
        const [r] = await pool.execute('INSERT INTO goods (title, price, description, image, status, user_id, user_name, views, comments_json) VALUES (?,?,?,?,1,?,?,0,"[]")', [title, price, desc, image||'', userId, userName]);
        res.json({ code: 0, id: r.insertId, msg: '发布成功' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/goods/update', async (req, res) => {
    try {
        const { id, title, price, desc, image } = req.body;
        await pool.execute('UPDATE goods SET title=?, price=?, description=?, image=? WHERE id=?', [title, price, desc, image, id]);
        res.json({ code: 0, msg: '修改成功' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/goods/status', async (req, res) => {
    try { await pool.execute('UPDATE goods SET status = ? WHERE id = ?', [req.body.status, req.body.id]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/goods/price', async (req, res) => {
    try { await pool.execute('UPDATE goods SET price = ? WHERE id = ?', [req.body.newPrice, req.body.goodsId]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/goods/comment', async (req, res) => {
    try {
        const { id, content, userName, userAvatar } = req.body;
        const [rows] = await pool.execute('SELECT comments_json FROM goods WHERE id = ?', [id]);
        let c = JSON.parse(rows[0].comments_json || '[]');
        c.push({ user: userName, avatar: userAvatar, content, time: new Date().toLocaleDateString() });
        await pool.execute('UPDATE goods SET comments_json = ? WHERE id = ?', [JSON.stringify(c), id]);
        res.json({ code: 0 });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

// --- Auth & User ---
app.post('/api/register', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id FROM users WHERE username = ?', [req.body.username]);
        if (rows.length > 0) return res.json({ code: 400, msg: '账号已存在' });
        await pool.execute('INSERT INTO users (username, password, nickname, avatar) VALUES (?, ?, ?, ?)', [req.body.username, req.body.password, req.body.nickname || 'User', '']);
        res.json({ code: 0, msg: '注册成功' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.username, req.body.password]);
        if (rows.length > 0) res.json({ code: 0, data: rows[0] });
        else res.json({ code: 400, msg: '账号或密码错误' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.get('/api/user/info', async (req, res) => {
    try {
        // 这里的 SELECT * 已经包含了我们在数据库里新加的 likes_count 字段
        const [u] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.query.id]);
        if (u.length === 0) return res.json({ code: 404 });
        const [fo] = await pool.execute('SELECT COUNT(*) as c FROM user_follows WHERE follower_id = ?', [req.query.id]);
        const [fa] = await pool.execute('SELECT COUNT(*) as c FROM user_follows WHERE followed_id = ?', [req.query.id]);
        const d = u[0]; d.followsCount = fo[0].c; d.fansCount = fa[0].c;
        res.json({ code: 0, data: d });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/user/avatar', async (req, res) => {
    try { await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [req.body.avatar, req.body.userId]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

// [新增] 点赞持久化接口
app.post('/api/user/like', async (req, res) => {
    try {
        const { userId } = req.body;
        // 让数据库里的 likes_count 原子自增 1
        await pool.execute('UPDATE users SET likes_count = likes_count + 1 WHERE id = ?', [userId]);
        res.json({ code: 0, msg: '感谢点赞' });
    } catch (e) { 
        res.status(500).json({ code: 500, error: e.message }); 
    }
});

// --- Social System ---
app.get('/api/social/check', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id FROM user_follows WHERE follower_id = ? AND followed_id = ?', [req.query.myId, req.query.targetId]);
        res.json({ code: 0, isFollow: rows.length > 0 });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/social/follow', async (req, res) => {
    try {
        const { myId, targetId } = req.body;
        if (myId == targetId) return res.json({ code: 400, msg: 'Self' });
        const [rows] = await pool.execute('SELECT id FROM user_follows WHERE follower_id = ? AND followed_id = ?', [myId, targetId]);
        if (rows.length > 0) {
            await pool.execute('DELETE FROM user_follows WHERE id = ?', [rows[0].id]);
            res.json({ code: 0, status: false, msg: '已取消' });
        } else {
            await pool.execute('INSERT INTO user_follows (follower_id, followed_id) VALUES (?, ?)', [myId, targetId]);
            res.json({ code: 0, status: true, msg: '已关注' });
        }
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.get('/api/social/list', async (req, res) => {
    try {
        const { userId, type } = req.query;
        let sql = type === 'follows' ? `SELECT u.* FROM user_follows f JOIN users u ON f.followed_id = u.id WHERE f.follower_id = ?` : `SELECT u.* FROM user_follows f JOIN users u ON f.follower_id = u.id WHERE f.followed_id = ?`;
        const [rows] = await pool.execute(sql, [userId]);
        res.json({ code: 0, data: rows });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

// --- Orders ---
app.post('/api/order/create', async (req, res) => {
    try {
        const { goodsId, buyerId, sellerId, amount } = req.body;
        const no = 'ORD' + Date.now();
        await pool.execute('INSERT INTO orders (order_no, goods_id, buyer_id, seller_id, amount) VALUES (?, ?, ?, ?, ?)', [no, goodsId, buyerId, sellerId, amount]);
        await pool.execute('UPDATE goods SET status = 2 WHERE id = ?', [goodsId]);
        res.json({ code: 0, msg: '购买成功' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.get('/api/order/my', async (req, res) => {
    try {
        const sql = `SELECT o.*, g.title, g.image FROM orders o LEFT JOIN goods g ON o.goods_id = g.id WHERE o.buyer_id = ? ORDER BY o.create_time DESC`;
        const [rows] = await pool.execute(sql, [req.query.userId]);
        res.json({ code: 0, data: rows });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

// --- Chat Persistence ---
app.post('/api/chat/save', async (req, res) => {
    try { await pool.execute('INSERT INTO chat_history (user_id, goods_id, is_me, content) VALUES (?, ?, ?, ?)', [req.body.userId, req.body.goodsId, req.body.isMe?1:0, req.body.content]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

app.get('/api/chat/history', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM chat_history WHERE user_id = ? AND goods_id = ? ORDER BY create_time ASC', [req.query.userId, req.query.goodsId]);
        res.json({ code: 0, data: rows.map(r => ({ isMe: r.is_me === 1, content: r.content })) });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/chat/clear', async (req, res) => {
    try { await pool.execute('DELETE FROM chat_history WHERE user_id = ? AND goods_id = ?', [req.body.userId, req.body.goodsId]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

// --- File Upload ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ code: 400 });
    // Returns relative path for cloud flexibility
    res.json({ code: 0, url: `/uploads/${req.file.filename}` });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));