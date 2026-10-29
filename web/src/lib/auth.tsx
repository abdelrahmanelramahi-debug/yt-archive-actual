"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

type AuthState = { user: User | null; loading: boolean };
const AuthCtx = createContext<AuthState>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });
  useEffect(() => onAuthStateChanged(auth, (user) => setState({ user, loading: false })), []);
  return <AuthCtx.Provider value={state}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);

// sign-in helpers (used by the sign-in screen)
export const signInWithGoogle = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signUpEmail = (email: string, pw: string) => createUserWithEmailAndPassword(auth, email, pw);
export const signInEmail = (email: string, pw: string) => signInWithEmailAndPassword(auth, email, pw);
export const signOutUser = () => fbSignOut(auth);

// the Firebase ID token for the current user, sent to the API so the server can verify who's asking
export const idToken = () => auth.currentUser?.getIdToken() ?? Promise.resolve(null);
