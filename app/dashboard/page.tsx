import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionCookieName, validSession } from '../../lib/session';
import DashboardClient from './dashboard-client';
export default async function Dashboard() {
  if (!(await validSession((await cookies()).get(sessionCookieName())?.value))) redirect('/');
  return <DashboardClient />;
}
