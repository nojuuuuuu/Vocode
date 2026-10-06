import { useEffect, useState, type FormEvent } from 'react';
import './HomePage.css';

type Transaction = {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  note: string;
  date: string;
};

const yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' });
const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || '通信に失敗しました。');
  return data;
}

function HomePage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function reload() {
    const data = await request('/api/transactions');
    setTransactions(data.transactions);
  }

  useEffect(() => {
    reload().catch((cause) => setError(`記録を読み込めませんでした: ${cause.message}`))
      .finally(() => setLoading(false));
  }, []);

  async function addTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await request('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, amount: Number(amount), category, note, date }),
      });
      await reload();
      setAmount('');
      setNote('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存できませんでした。');
    } finally {
      setSaving(false);
    }
  }

  async function deleteTransaction(item: Transaction) {
    if (!window.confirm(`${item.category}（${yen.format(item.amount)}）を削除しますか？`)) return;
    setError('');
    try {
      await request(`/api/transactions/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '削除できませんでした。');
    }
  }

  const income = transactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const expense = transactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);

  return (
    <main className="money-page">
      <header className="money-header">
        <span className="home-eyebrow">MONEY管理アプリ</span>
        <h1 className="home-title">お金のことを、<br />ここから。</h1>
        <p className="home-description">収入と支出を記録すると、この端末のデータベースに保存されます。</p>
      </header>

      <section className="summary-grid" aria-label="収支の合計">
        <div className="summary-card"><span>収入</span><strong>{yen.format(income)}</strong></div>
        <div className="summary-card"><span>支出</span><strong>{yen.format(expense)}</strong></div>
        <div className="summary-card balance"><span>残高</span><strong>{yen.format(income - expense)}</strong></div>
      </section>

      <div className="money-columns">
        <section className="home-card" aria-labelledby="add-heading">
          <h2 id="add-heading">新しい記録</h2>
          <form className="transaction-form" onSubmit={addTransaction}>
            <div className="type-picker" role="group" aria-label="記録の種類">
              <button type="button" className={type === 'expense' ? 'active' : ''} aria-pressed={type === 'expense'} onClick={() => setType('expense')}>支出</button>
              <button type="button" className={type === 'income' ? 'active' : ''} aria-pressed={type === 'income'} onClick={() => setType('income')}>収入</button>
            </div>
            <label>金額（円）<input type="number" min="1" max="1000000000" step="1" required value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例：1200" /></label>
            <label>分類<input type="text" maxLength={40} required value={category} onChange={(event) => setCategory(event.target.value)} placeholder="例：食費" /></label>
            <label>日付<input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
            <label>メモ（任意）<input type="text" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="何に使ったかなど" /></label>
            <button className="save-transaction" type="submit" disabled={saving}>{saving ? '保存中…' : '記録を保存'}</button>
          </form>
        </section>

        <section className="home-card history-card" aria-labelledby="history-heading">
          <h2 id="history-heading">記録一覧</h2>
          {error && <p className="form-error" role="alert">{error}</p>}
          {loading ? <p className="empty-state">読み込み中…</p> : transactions.length === 0 ? <p className="empty-state">まだ記録がありません。左のフォームから追加できます。</p> : (
            <ul className="transaction-list">
              {transactions.map((item) => (
                <li key={item.id} className="transaction-item">
                  <div><span className="transaction-date">{item.date}</span><strong>{item.category}</strong>{item.note && <small>{item.note}</small>}</div>
                  <span className={item.type === 'income' ? 'amount income' : 'amount'}>{item.type === 'income' ? '+' : '−'}{yen.format(item.amount)}</span>
                  <button type="button" className="delete-transaction" onClick={() => deleteTransaction(item)} aria-label={`${item.category}を削除`}>削除</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

export default HomePage;
