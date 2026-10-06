import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import db from './db.js';

type TransactionType = 'income' | 'expense';

type Transaction = {
  id: string;
  type: TransactionType;
  amount: number;
  category: string;
  note: string;
  date: string;
  created_at: string;
};

type TransactionInput = Omit<Transaction, 'id' | 'created_at'>;

const app = express();
const port = Number(process.env.API_PORT ?? 3001);
app.disable('x-powered-by');
app.use((request, response, next) => {
  if (request.headers.host !== `127.0.0.1:${port}`) {
    response.status(403).json({ error: 'このホストからは利用できません。' });
    return;
  }
  if (request.headers.origin && ![`http://127.0.0.1:${port}`, 'http://127.0.0.1:5173'].includes(request.headers.origin)) {
    response.status(403).json({ error: 'このページからは利用できません。' });
    return;
  }
  next();
});
app.use(express.json({ limit: '32kb' }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseTransactionInput(value: unknown): TransactionInput | null {
  if (!isRecord(value)) return null;

  const { type, amount, category, note, date } = value;
  if (type !== 'income' && type !== 'expense') return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (typeof category !== 'string' || category.trim().length === 0 || category.trim().length > 40) return null;
  if (typeof note !== 'string' || note.length > 200) return null;
  if (typeof date !== 'string' || !isValidDate(date)) return null;

  return {
    type,
    amount,
    category: category.trim(),
    note: note.trim(),
    date,
  };
}

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/transactions', (_request, response) => {
  const transactions = db
    .prepare(
      `SELECT id, type, amount, category, note, date, created_at
       FROM transactions
       ORDER BY date DESC, created_at DESC`,
    )
    .all() as Transaction[];

  response.json({ transactions });
});

app.post('/api/transactions', (request, response) => {
  const input = parseTransactionInput(request.body);
  if (!input) {
    response.status(400).json({
      error: '入力内容を確認してください。金額・種別・カテゴリ・日付は必須です。',
    });
    return;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO transactions (id, type, amount, category, note, date)
     VALUES (@id, @type, @amount, @category, @note, @date)`,
  ).run({ id, ...input });

  const transaction = db
    .prepare(
      `SELECT id, type, amount, category, note, date, created_at
       FROM transactions WHERE id = ?`,
    )
    .get(id) as Transaction;

  response.status(201).json({ transaction });
});

app.delete('/api/transactions/:id', (request, response) => {
  const id = request.params.id;
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);

  if (result.changes === 0) {
    response.status(404).json({ error: '指定した収支データが見つかりません。' });
    return;
  }

  response.status(204).end();
});

app.use((_request, response) => {
  response.status(404).json({ error: '指定されたAPIが見つかりません。' });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'サーバーでエラーが発生しました。' });
};
app.use(errorHandler);

app.listen(port, '127.0.0.1', () => {
  console.log(`API server listening on http://127.0.0.1:${port}`);
});
