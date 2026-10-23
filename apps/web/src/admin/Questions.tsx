import { useEffect, useState } from 'react';
import { api } from '../api';
import { languageName } from '../types';

interface Question {
  id: number;
  locale: string;
  text: string;
  answer: string | null;
  user: string;
  key: string;
  source: string;
}

export function Questions({ projectId }: { projectId: number }) {
  const [qs, setQs] = useState<Question[]>([]);
  const load = () => api<{ questions: Question[] }>(`/api/v1/projects/${projectId}/questions`).then((r) => setQs(r.questions));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function answer(e: React.FormEvent<HTMLFormElement>, id: number) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api(`/api/v1/questions/${id}/answer`, { body: { answer: f.get('answer'), description: f.get('note') === 'on' } });
    await load();
  }

  if (!qs.length) return <div className="card muted">No questions from localizers yet.</div>;
  return (
    <div className="stack">
      {qs.map((q) => (
        <div key={q.id} className="card stack">
          <div className="small muted">
            {q.user} · {languageName(q.locale)} · “{q.source}”
          </div>
          <div>{q.text}</div>
          {q.answer ? (
            <div className="alert ok">{q.answer}</div>
          ) : (
            <form className="row" onSubmit={(e) => void answer(e, q.id)}>
              <input name="answer" placeholder="Your answer" style={{ flex: 1 }} required />
              <label className="row small">
                <input type="checkbox" name="note" defaultChecked /> also add to the string's note
              </label>
              <button className="primary">Answer</button>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
