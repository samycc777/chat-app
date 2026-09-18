import { useState } from 'react';
import { api } from '../api';

interface Props {
  onAuth: (token: string) => void;
}

export default function Auth({ onAuth }: Props) {
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
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-container">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>ChatApp</h1>
        <p>{isLogin ? 'Sign in to continue' : 'Create your account'}</p>

        {error && <div className="auth-error">{error}</div>}

        <div className="input-group">
          <label>Username</label>
          <input
            type="text"
            placeholder="Enter username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>

        {!isLogin && (
          <div className="input-group">
            <label>Display Name</label>
            <input
              type="text"
              placeholder="Your name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
            />
          </div>
        )}

        <div className="input-group">
          <label>Password</label>
          <input
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
          />
        </div>

        <button type="submit" className="auth-btn" disabled={loading}>
          {loading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
        </button>

        <div className="auth-switch">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <span onClick={() => { setIsLogin(!isLogin); setError(''); }}>
            {isLogin ? 'Sign up' : 'Sign in'}
          </span>
        </div>
      </form>
    </div>
  );
}
