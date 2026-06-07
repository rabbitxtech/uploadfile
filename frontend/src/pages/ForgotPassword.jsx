import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Cloud, ArrowLeft } from 'lucide-react';
import { AuthApi } from '../api/endpoints.js';

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await AuthApi.forgotPassword(identifier.trim());
      setSent(true);
    } catch {
      setSent(true); // never reveal whether the account exists
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2 text-brand-700 dark:text-brand-400">
          <Cloud className="h-7 w-7" />
          <span className="text-xl font-semibold">Reset password</span>
        </div>
        {sent ? (
          <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <p>
              If an account exists for <strong>{identifier}</strong>, a reset link has been sent.
              Check your email and follow the link (it expires in 1 hour).
            </p>
            <p className="text-xs text-slate-400">
              No email configured? The reset link is printed in the server log.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              Enter your username or email and we'll send a reset link.
            </p>
            <input
              className="input"
              placeholder="Username or email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            <button disabled={loading || !identifier.trim()} className="btn-primary mt-4 w-full justify-center">
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </>
        )}
        <p className="mt-4 text-center text-sm">
          <Link to="/login" className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
