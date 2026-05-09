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

// [云端适配] 优先读取平台分配的端口，本地默认为 3000
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// 静态文件服务：将 uploads 文件夹映射到 /uploads 路径
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ⚠️ SiliconFlow API Key
const SILICON_API_KEY = "sk-xtfxbevwghsfahueuppeargbpzeryhtphecpscpmrhxyhmiu"; 

// [云端适配] 数据库连接配置：优先读取环境变量，适配 Aiven 的 SSL 要求
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '123456',
    database: process.env.MYSQL_DATABASE || 'campus_trade',
    port: process.env.MYSQL_PORT || 3306,
    timezone: '+08:00',
    // 云数据库 Aiven 必须开启 SSL
    ssl: process.env.MYSQL_HOST ? { rejectUnauthorized: false } : null,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 文件上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// ================= API 接口部分 =================

// --- [核心功能] AI 智能回复接口 ---
app.post('/api/chat/reply', async (req, res) => {
    const { text, productName, price, history } = req.body;
    
    if (!SILICON_API_KEY || SILICON_API_KEY.includes('sk-xxxx')) {
        return res.json({ code: 0, data: "Key无效" });
    }

    try {
        const currentPrice = Number(price);
        const minPrice = (currentPrice * 0.8).toFixed(2); // 8折底线

        const messages = [
            { 
                role: "system", 
                content: `你是校园二手平台的真实卖家（大学生）。你正在出售【${productName}】，标价【${currentPrice}元】。

                【沟通策略】：
                1. 语气自然随和，多用“宝子”、“同学”等称呼。
                2. 如果买家出价低于 ${minPrice} 元，请礼貌拒绝。
                3. 如果出价在 ${minPrice} 到 ${currentPrice} 之间，可以尝试拉扯或直接成交。
                4. 【绝对红线】：严禁对买家说出你的底价规则。

                【成交指令】：
                1. 只有你最终同意价格时，才在句末加 ##价格## 暗号。
                2. 打招呼或拉扯阶段严禁输出 ##。
                3. 只说中文，严禁输出任何英文字母乱码。`
            }
        ];

        if (history && history.length > 0) {
            const recentHistory = history.slice(-8);
            recentHistory.forEach(msg => {
                messages.push({
                    role: msg.isMe ? "user" : "assistant",
                    content: msg.content
                });
            });
        }

        const response = await axios.post('https://api.siliconflow.cn/v1/chat/completions', {
            model: "Qwen/Qwen2.5-7B-Instruct",
            messages: messages,
            stream: false,
            max_tokens: 150,
            temperature: 0.5 
        }, {
            headers: { 'Authorization': `Bearer ${SILICON_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000,
            proxy: false, 
            httpsAgent: new https.Agent({ rejectUnauthorized: false, family: 4 }) 
        });

        const aiReply = response.data.choices[0].message.content;
        res.json({ code: 0, data: aiReply });

    } catch (err) {
        console.error('AI Error:', err.message);
        res.json({ code: 0, data: "宝子，学校网有点卡，你刚才说什么？" });
    }
});

// --- 商品相关接口 ---
app.get('/api/goods', async (req, res) => {
    try {
        const { status, keyword, userId, id } = req.query;
        let sql = 'SELECT g.*, u.avatar as user_avatar, u.nickname as seller_nick FROM goods g LEFT JOIN users u ON g.user_id = u.id WHERE 1=1';
        let params = [];
        if (!status && !id) sql += ' AND g.status != 3';
        if (id) { sql += ' AND g.id = ?'; params.push(id); }
        if (status) { sql += ' AND g.status = ?'; params.push(status); }
        if (userId) { sql += ' AND g.user_id = ?'; params.push(userId); }
        if (keyword) { sql += ' AND g.title LIKE ?'; params.push(`%${keyword}%`); }
        sql += ' ORDER BY g.create_time DESC';
        const [rows] = await pool.execute(sql, params);
        const list = rows.map(r => ({
            ...r, user_name: r.seller_nick || r.user_name, user_avatar: r.user_avatar || '', 
            comments: r.comments_json ? JSON.parse(r.comments_json) : []
        }));
        res.json({ code: 0, data: list });
    } catch (e) { res.status(500).json({ code: 500 }); }
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
    try { await pool.execute('UPDATE goods SET status = ? WHERE id = ?', [req.body.status, req.body.id]); res.json({ code: 0, msg: '操作成功' }); } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/goods/price', async (req, res) => {
    try { await pool.execute('UPDATE goods SET price = ? WHERE id = ?', [req.body.newPrice, req.body.goodsId]); res.json({ code: 0, msg: '改价成功' }); } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/goods/comment', async (req, res) => {
    try {
        const { id, content, userName, userAvatar } = req.body;
        const [rows] = await pool.execute('SELECT comments_json FROM goods WHERE id = ?', [id]);
        let c = JSON.parse(rows[0].comments_json || '[]');
        c.push({ user: userName, avatar: userAvatar, content, time: new Date().toLocaleDateString() });
        await pool.execute('UPDATE goods SET comments_json = ? WHERE id = ?', [JSON.stringify(c), id]);
        res.json({ code: 0, msg: '评论成功' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

// --- 用户与社交接口 ---
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
        if (rows.length > 0) res.json({ code: 0, msg: '登录成功', data: rows[0] });
        else res.json({ code: 400, msg: '账号或密码错误' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.get('/api/user/info', async (req, res) => {
    try {
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

app.post('/api/user/like', async (req, res) => {
    try { await pool.execute('UPDATE users SET likes = likes + 1 WHERE id = ?', [req.body.userId]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

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

// --- 订单与聊天记录接口 ---
app.post('/api/order/create', async (req, res) => {
    try {
        const { goodsId, buyerId, sellerId, amount } = req.body;
        const [g] = await pool.execute('SELECT status FROM goods WHERE id = ?', [goodsId]);
        if (g.length === 0 || g[0].status !== 1) return res.json({ code: 400, msg: '已售出' });
        const no = 'ORD' + Date.now() + Math.floor(Math.random() * 1000);
        await pool.execute('INSERT INTO orders (order_no, goods_id, buyer_id, seller_id, amount) VALUES (?, ?, ?, ?, ?)', [no, goodsId, buyerId, sellerId, amount]);
        await pool.execute('UPDATE goods SET status = 2 WHERE id = ?', [goodsId]);
        res.json({ code: 0, msg: '购买成功' });
    } catch (e) { res.status(500).json({ code: 500, msg: '交易失败' }); }
});

app.get('/api/order/my', async (req, res) => {
    try {
        const sql = `SELECT o.*, g.title, g.image, g.user_name as seller_name FROM orders o LEFT JOIN goods g ON o.goods_id = g.id WHERE o.buyer_id = ? ORDER BY o.create_time DESC`;
        const [rows] = await pool.execute(sql, [req.query.userId]);
        res.json({ code: 0, data: rows });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.get('/api/chat/history', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM chat_history WHERE user_id = ? AND goods_id = ? ORDER BY create_time ASC', [req.query.userId, req.query.goodsId]);
        res.json({ code: 0, data: rows.map(row => ({ isMe: row.is_me === 1, content: row.content })) });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/chat/save', async (req, res) => {
    try { await pool.execute('INSERT INTO chat_history (user_id, goods_id, is_me, content) VALUES (?, ?, ?, ?)', [req.body.userId, req.body.goodsId, req.body.isMe?1:0, req.body.content]); res.json({ code: 0 }); } catch (e) { res.status(500).json({ code: 500 }); }
});

app.post('/api/chat/clear', async (req, res) => {
    try { await pool.execute('DELETE FROM chat_history WHERE user_id = ? AND goods_id = ?', [req.body.userId, req.body.goodsId]); res.json({ code: 0, msg: '已清空' }); } catch (e) { res.status(500).json({ code: 500 }); }
});

// --- 文件上传接口 ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ code: 400 });
    // 返回相对路径，前端会根据 BASE_URL 自动拼接
    res.json({ code: 0, url: `/uploads/${req.file.filename}` });
});

// [云端适配] 必须监听 0.0.0.0
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));