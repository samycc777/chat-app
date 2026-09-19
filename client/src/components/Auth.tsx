import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface Props {
  onAuth: (token: string) => void;
}

export default function Auth({ onAuth }: Props) {
  const { t, translateError } = useI18n();
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = isLogin
        ? await api.login(username, password)
        : await api.register(username, displayName, password);
      localStorage.setItem('token', data.token);
      onAuth(data.token);
    } catch (err: any) {
      setError(translateError(err.message));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-container">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>{t('appName')}</h1>
        <p>{isLogin ? t('signInToContinue') : t('createYourAccount')}</p>

        {error && <div className="auth-error">{error}</div>}

        <div className="input-group">
          <label>{t('username')}</label>
          <input
            type="text"
            placeholder={t('enterUsername')}
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>

        {!isLogin && (
          <div className="input-group">
            <label>{t('displayName')}</label>
            <input
              type="text"
              placeholder={t('yourName')}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
          </div>
        )}

        <div className="input-group">
          <label>{t('password')}</label>
          <input
            type="password"
            placeholder={t('enterPassword')}
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
          />
        </div>

        <button type="submit" className="auth-btn" disabled={loading}>
          {loading ? t('pleaseWait') : isLogin ? t('signIn') : t('createAccount')}
        </button>

        <div className="auth-switch">
          {isLogin ? t('noAccount') : t('haveAccount')}
          <span onClick={() => { setIsLogin(!isLogin); setError(''); }}>
            {isLogin ? t('signUp') : t('signIn')}
          </span>
        </div>
      </form>
    </div>
  );
}
