import { redirect } from 'next/navigation';

/** The Integration menu holds every outside connection; this address is the short link to it. */
export default function IntegrationsRedirect() {
  redirect('/admin/integrations?section=api-access');
}
