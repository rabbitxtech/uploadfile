import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { Cloud, ArrowLeft } from 'lucide-react';
import { AuthApi } from '../api/endpoints.js';

export default function ForgotPassword() {
  const { t } = useTranslation();
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
          <span className="text-xl font-semibold">{t('forgot.title')}</span>
        </div>
        {sent ? (
          <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <p>
              <Trans i18nKey="forgot.sentIntro" values={{ id: identifier }}><strong>id</strong></Trans>
            </p>
            <p className="text-xs text-slate-400">
              {t('forgot.noEmailConfigured')}
            </p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
              {t('forgot.prompt')}
            </p>
            <input
              className="input"
              placeholder={t('auth.usernameOrEmail')}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            <button disabled={loading || !identifier.trim()} className="btn-primary mt-4 w-full justify-center">
              {loading ? t('forgot.sending') : t('forgot.sendLink')}
            </button>
          </>
        )}
        <p className="mt-4 text-center text-sm">
          <Link to="/login" className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
            <ArrowLeft className="h-3.5 w-3.5" /> {t('auth.backToSignIn')}
          </Link>
        </p>
      </form>
    </div>
  );
}
