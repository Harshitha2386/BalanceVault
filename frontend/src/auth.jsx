import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const hasSession = useRef(false);

  const acceptUser = useCallback((nextUser) => {
    hasSession.current = true;
    setUser(nextUser);
    setSessionExpired(false);
    setSessionError('');
  }, []);

  const refresh = useCallback(async () => {
    setSessionError('');
    try {
      const result = await api.get('/auth/me');
      hasSession.current = true;
      setUser(result.user);
      return result.user;
    } catch (error) {
      if (error.status === 401) {
        hasSession.current = false;
        setUser(null);
        setSessionError('');
        return null;
      }
      setSessionError('BalanceVault could not verify your session. Check that the backend is available.');
      throw error;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const handleUnauthorized = () => {
      if (!hasSession.current) return;
      hasSession.current = false;
      setUser(null);
      setSessionExpired(true);
    };
    window.addEventListener('balancevault:unauthorized', handleUnauthorized);
    api.get('/auth/me')
      .then((result) => {
        if (active) {
          hasSession.current = true;
          setUser(result.user);
        }
      })
      .catch((error) => {
        if (error.status !== 401 && active) {
          setSessionError('BalanceVault could not verify your session. Check that the backend is available.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.removeEventListener('balancevault:unauthorized', handleUnauthorized);
    };
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    sessionError,
    sessionExpired,
    refresh,
    acceptUser,
    clearUser: () => {
      hasSession.current = false;
      setSessionExpired(false);
      setUser(null);
    },
  }), [user, loading, sessionError, sessionExpired, refresh, acceptUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}

export { AuthProvider, useAuth };
