import { requestUser } from '../../../lib/supabase-server';
import { sameOrigin } from '../../../lib/request-origin';
import { AUTH_MESSAGES } from '../../../lib/auth-messages';
import { travelDashboard, travelInput, compareDestinations } from '../../../lib/travel-dashboard';
export const maxDuration = 65;
export async function POST(request: Request) {
  // Weryfikacja użytkownika przed odczytem danych i zapytaniami do zewnętrznych usług.
  if (!(await requestUser(request))) return Response.json({ error: AUTH_MESSAGES.unauthorized }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: 'Niedozwolone źródło żądania.' }, { status: 403 });
  try {
    const input = travelInput.extend({ secondCity: travelInput.shape.city.optional() }).safeParse(await request.json());
    if (!input.success) return Response.json({ error: 'Podaj miasto i poprawną datę.' }, { status: 400 });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
    if (input.data.secondCity && input.data.city.toLocaleLowerCase() === input.data.secondCity.toLocaleLowerCase()) {
      return Response.json({ error: 'Wpisz dwa różne miasta.' }, { status: 400 });
    }
    return Response.json(input.data.secondCity
      ? await compareDestinations(input.data.city, input.data.secondCity, input.data.date, signal)
      : await travelDashboard({ city: input.data.city, date: input.data.date }, signal), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error && /miast|region|wyszukać/.test(error.message) ? error.message : 'Nie udało się pobrać danych podróży. Spróbuj ponownie.';
    return Response.json({ error: message }, { status: 502 });
  }
}
