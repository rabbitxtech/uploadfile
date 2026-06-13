import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cloud } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthApi } from '../api/endpoints.js';

export default function ResetPassword() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 6) return toast.error(t('profile.passwordTooShort'));
    if (password !== confirm) return toast.error(t('profile.passwordsNoMatch'));
    setLoading(true);
    try {
      await AuthApi.resetPassword(token, password);
      toast.success(t('reset.updated'));
      navigate('/login');
    } catch (e) {
      toast.error(e.response?.data?.error || t('reset.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2 text-brand-700 dark:text-brand-400">
          <Cloud className="h-7 w-7" />
          <span className="text-xl font-semibold">{t('reset.title')}</span>
        </div>
        {!token ? (
          <p className="text-sm text-red-500">{t('reset.missingLink')}</p>
        ) : (
          <div className="space-y-3">
            <input
              type="password"
              className="input"
              placeholder={t('reset.newPassword')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <input
              type="password"
              className="input"
              placeholder={t('reset.confirmNewPassword')}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            <button disabled={loading} className="btn-primary w-full justify-center">
              {loading ? t('reset.saving') : t('reset.resetPassword')}
            </button>
          </div>
        )}
        <p className="mt-4 text-center text-sm">
          <Link to="/login" className="text-brand-600 hover:underline dark:text-brand-400">
            {t('auth.backToSignIn')}
          </Link>
        </p>
      </form>
    </div>
  );
}
