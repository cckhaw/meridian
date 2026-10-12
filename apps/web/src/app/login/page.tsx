import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default function Page() {
  return <Suspense><LoginForm /></Suspense>;
}
