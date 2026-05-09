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

// [云端适配] 优先读取平台分配的端口，Render 默认通常是 10000 或由 process.env.PORT 指定
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ⚠️ SiliconFlow API Key
const SILICON_API_KEY = "sk-xtfxbevwghsfahueuppeargbpzeryhtphecpscpmrhxyhmiu"; 

// [云端适配] 数据库连接池
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '123456',
    database: process.env.MYSQL_DATABASE || 'campus_trade',
    port: process.env.MYSQL_PORT || 3306,
    timezone: '+08:00',
    // Aiven 云数据库强制要求 SSL
    ssl: process.env.MYSQL_HOST ? { rejectUnauthorized: false } : null,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ================= 诊断接口 (修复你的问题) =================

// 1. 首页欢迎页：防止出现 "Cannot GET /"
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

// 2. 数据库健康检查接口
app.get('/debug/db', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT 1 + 1 AS result');
        res.json({ status: 'success', message: '数据库连接正常', data: rows });
    } catch (err) {
        res.json({ status: 'error', message: '数据库连接失败', detail: err.message });
    }
});

// ================= 原有 API 接口 =================

// 获取商品
app.get('/api/goods', async (req, res) => {
    try {
        const { keyword } = req.query;
        let sql = 'SELECT g.*, u.avatar as user_avatar, u.nickname as seller_nick FROM goods g LEFT JOIN users u ON g.user_id = u.id WHERE g.status = 1';
        let params = [];
        if (keyword) { sql += ' AND g.title LIKE ?'; params.push(`%${keyword}%`); }
        sql += ' ORDER BY g.create_time DESC';
        const [rows] = await pool.execute(sql, params);
        res.json({ code: 0, data: rows });
    } catch (e) { res.status(500).json({ code: 500, error: e.message }); }
});

// AI 智能回复
app.post('/api/chat/reply', async (req, res) => {
    const { productName, price, history } = req.body;
    try {
        const messages = [{ role: "system", content: `你是校园卖家，卖${productName}，价格${price}。` }];
        const response = await axios.post('https://api.siliconflow.cn/v1/chat/completions', {
            model: "Qwen/Qwen2.5-7B-Instruct",
            messages: messages
        }, {
            headers: { 'Authorization': `Bearer ${SILICON_API_KEY}` },
            httpsAgent: new https.Agent({ family: 4 }) 
        });
        res.json({ code: 0, data: response.data.choices[0].message.content });
    } catch (err) { res.json({ code: 0, data: "网卡了..." }); }
});

// [其他接口保持不变...]
app.post('/api/login', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND password = ?', [req.body.username, req.body.password]);
        if (rows.length > 0) res.json({ code: 0, data: rows[0] });
        else res.json({ code: 400, msg: '失败' });
    } catch (e) { res.status(500).json({ code: 500 }); }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });
app.post('/api/upload', upload.single('file'), (req, res) => {
    res.json({ code: 0, url: `/uploads/${req.file.filename}` });
});

// 监听端口
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));