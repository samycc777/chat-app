import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import authRouter from './auth';
import apiRouter from './routes';
import { setupSocket } from './socket';

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

setupSocket(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
