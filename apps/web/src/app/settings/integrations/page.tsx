import { redirect } from 'next/navigation';

/** The integration hub lives in the Integration menu; this address is the short link to it. */
export default function IntegrationsRedirect() {
  redirect('/admin/integrations?view=hub');
}
