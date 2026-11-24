import { redirect } from 'next/navigation';
import { loginPath } from '../../lib/redirect-target';
import { currentUser } from '../../lib/supabase-server';
import DashboardClient from './dashboard-client';
export default async function Dashboard() {
  const user = await currentUser();
  if (!user) redirect(loginPath('/dashboard'));
  return <DashboardClient email={user.email} />;
}
