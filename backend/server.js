import express from 'express';
import cors from 'cors'; // 如跨域需启用
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.type('text').send('ok'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('SERVER on :' + port));
