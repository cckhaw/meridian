'use client';
import { Alert, LargeTitle, Segmented, Spinner } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { NotificationsTab } from './notifications';
import { PersonalTab } from './personal';
import { SecurityTab } from './security';

export interface Profile {
  id: string; username: string; displayName: string; email: string | null; phone: string | null; avatar: string | null; isSuperuser: boolean; roles: string[];
  passwordChangedAt: string | null; lastLoginAt: string | null;
  organisation: { storeId: string | null; storeName: string | null; dealerId: string | null; dealerName: string | null };
  notificationPrefs: { channels: { email: boolean; sms: boolean; push: boolean }; events: { caseAssigned: boolean; caseUpdates: boolean; systemAlerts: boolean; securityAlerts: boolean } };
}

/** My profile: what a person keeps about themselves, how they sign in, and which alerts reach them. Everyone who is signed in has it. */
export default function ProfilePage() {
  return <Suspense fallback={<Spinner />}><Profile /></Suspense>;
}

function Profile() {
  const { me } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const tab = (['personal', 'security', 'notifications'].includes(sp.get('tab') ?? '') ? sp.get('tab') : sp.get('setup') === 'mfa' ? 'security' : 'personal') as 'personal' | 'security' | 'notifications';
  const profile = useApi<Profile>('/profile');
  const go = (t: string) => router.replace(`/profile?tab=${t}${sp.get('setup') ? `&setup=${sp.get('setup')}` : ''}`);
  return (
    <>
      <LargeTitle subtitle="Your details, how you sign in, and the alerts you get.">My profile</LargeTitle>
      {me?.mfaEnrollRequired && <div className="mb-4"><Alert tone="info">Your role needs a second step at sign-in. Set one up under <strong>Security</strong> to continue.</Alert></div>}
      <div className="mb-5"><Segmented label="Profile section" value={tab} options={[{ value: 'personal', label: 'Personal' }, { value: 'security', label: 'Security' }, { value: 'notifications', label: 'Notifications' }]} onChange={go} /></div>
      {profile.error && <Alert>{profile.error}</Alert>}
      {!profile.data ? <Spinner /> : tab === 'personal' ? <PersonalTab p={profile.data} reload={profile.reload} /> : tab === 'security' ? <SecurityTab p={profile.data} /> : <NotificationsTab p={profile.data} reload={profile.reload} />}
    </>
  );
}
