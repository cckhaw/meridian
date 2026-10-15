import { redirect } from 'next/navigation';

/** The dunning rules live with the other settings; this address is the short link to them. */
export default function DunningRulesRedirect() {
  redirect('/admin/settings?section=dunning-rules');
}
