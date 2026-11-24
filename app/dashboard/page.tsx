import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/supabase-server';
import DashboardClient from './dashboard-client';
export default async function Dashboard() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <DashboardClient email={user.email} />;
}
