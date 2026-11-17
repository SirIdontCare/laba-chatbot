# Mój chatbot — LABA

Next.js App Router z TypeScript. Czat i analiza korzystają z serwerowego `/api/agent` oraz OpenRouter i AI SDK. Po odświeżeniu czat wczytuje z Supabase ostatnią rozmowę bieżącej sesji. „Nowa rozmowa” czyści widok i pozostawia wcześniejszą rozmowę w bazie.

`POST /api/agent` najpierw sprawdza sesję (bez niej zwraca 401), a potem tryb:

| Tryb | Dane wejściowe | Wynik |
| --- | --- | --- |
| `chat` | `{ mode: "chat", chatId: "<uuid>", messages: [...] }` | Strumień UI z `streamText`, maks. 18 kroków modelu. Ogólny asystent z ośmioma narzędziami opisanymi poniżej, zachowanym `aktualnyCzas`, wyszukiwaniem i obsługą obrazów. |
| `analyze` | `{ mode: "analyze", message: "..." }` | `{ result: ... }` z `generateText`, `Output.object` i walidacją Zod na serwerze. |

Przycisk „Wygeneruj obraz” wysyła tryb `chat` z `intent: "image"` i wymusza pierwsze wywołanie `generujObraz` (opis do 500 znaków). Obraz i identyfikator modelu z API trafiają do rozmowy jako wynik narzędzia. `toModelOutput` przekazuje modelowi wyłącznie tekst „obraz wygenerowany”, również przy odtwarzaniu historii. Nie ma ponownego wysyłania pliku obrazu do modelu.

Instrukcje Studio Nova i format szkicu dotyczą wyłącznie `analyze`. Czat wykonuje zadania ogólne. Przy zadaniu z logo wyszukuje źródło, przekazuje znaleziony bezpośredni URL PNG/JPG/WebP do `obejrzyjObraz`, opisuje widoczny obraz, a potem może użyć tego samego URL w `referenceImageUrls` narzędzia generowania. Adres referencji bez wcześniejszego przekazania do vision jest odrzucany. Obraz referencyjny przekazywany jest dostawcy vision i generatorowi; serwer aplikacji nie pobiera tych adresów. Gdy dostępna jest tylko strona HTML, SVG lub niedziałający adres, asystent ma zgłosić ograniczenie i poprosić o odpowiedni plik lub URL.

Pełny zestaw testów agenta: `npm run test:agent`. Testy zastępują połączenia z modelami atrapami. Obejmują oba tryby, autoryzację, narzędzia, zdjęcia i oddzielenie obrazu dla UI od krótkiego wyniku dla modelu.

## Konfiguracja lokalna

W folderze projektu, obok `package.json`, utwórz plik `.env.local`. Jeśli już istnieje, uzupełnij tylko te dwie zmienne, zachowując pozostałą zawartość:

```dotenv
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
```

Po pierwszym `=` wpisz swój klucz OpenRouter. Po drugim wpisz dokładny identyfikator modelu skopiowany z [listy modeli OpenRouter](https://openrouter.ai/models), w formacie `dostawca/model`. Wartości podajesz wyłącznie w lokalnym pliku, nie w rozmowie. Nie dodawaj prefiksu `NEXT_PUBLIC_`.

Historia czatu wymaga adresu projektu w `SUPABASE_URL` oraz klucza serwerowego w `SUPABASE_SECRET_KEY`. Obie zmienne należą do środowiska serwera. Skrypt `supabase/create_chat_tables.sql` uzupełnia tabele `conversations` i `messages` oraz instaluje funkcję zapisu pary wiadomości. Czat zapisuje zakończone tury wraz z tekstem i dopiskami `[obraz]`. Ponowne logowanie rozpoczyna odrębną sesję.

Zapisz plik. Jeśli serwer działał podczas zmiany konfiguracji, uruchom go ponownie: zakończ go przez `Ctrl+C`, a następnie wpisz w terminalu:

```powershell
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
```

Otwórz [http://127.0.0.1:3000](http://127.0.0.1:3000). Pierwszą prawdziwą wiadomość wysyła użytkownik w przeglądarce. Wybrany model może naliczać opłaty zgodnie z cennikiem OpenRouter.

`.env` i `.env.local` są ignorowane przez Git. `.env.example` zawiera wyłącznie puste pola. Klucz odczytuje tylko serwerowy endpoint. Brak wartości powoduje czytelny komunikat; aplikacja nie generuje zastępczej odpowiedzi.

## Wersje i sprawdzenie

- `ai`: 7.0.157
- `@ai-sdk/react`: 4.0.161 (zależność od `ai` 7.0.157)
- `@openrouter/ai-sdk-provider`: 3.1.0 (wymaga `ai` ^7.0.0 i Node.js >=22)
- `zod`: 4.1.8 (zgodne wymagania obu pakietów)

Wersje są przypięte w `package.json` i zapisane w zachowanym `package-lock.json`. Zgodność sprawdzono w [oficjalnej dokumentacji OpenRouter](https://github.com/OpenRouterTeam/ai-sdk-provider#setup-for-ai-sdk-v7), [przykładzie czatu AI SDK 7](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot) oraz metadanych zainstalowanych pakietów.

W AI SDK 7 serwer używa `streamText` → `toUIMessageStream` → `createUIMessageStreamResponse`, a klient `useChat` z `DefaultChatTransport`. Transport wysyła całą historię; serwer przekształca ją przez `convertToModelMessages`.

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Test lokalny z zastąpionym połączeniem sieciowym potwierdził strumieniowe fragmenty, przekazywanie historii, odrzucanie pustych wiadomości, brak konfiguracji i bezpieczny błąd dostawcy. Nie wykonano prawdziwych wywołań OpenRouter.

## Hasło warsztatowe

W `.env.local` dodaj `CHAT_PASSWORD=` i wpisz po znaku `=` własne, długie hasło warsztatowe. Dla wartości zawierających `#` lub spacje użyj cudzysłowów, np. `CHAT_PASSWORD="twoje hasło"`. Nie umieszczaj hasła w kodzie ani w rozmowie. Zachowaj pozostałe zmienne.

`SESSION_SECRET` został wygenerowany kryptograficznie (32 losowe bajty) i dopisany do `.env.local` bez odczytywania istniejących sekretów i bez wyświetlania wartości. Nie zastępuj go hasłem. Aby świadomie wygenerować nowy sekret i unieważnić dotychczasowe sesje, uruchom:

```powershell
npm.cmd run session:secret
```

Skrypt dopisuje nową linię `SESSION_SECRET` bez czytania pliku; ostatnia definicja tej zmiennej obowiązuje po ponownym uruchomieniu Next.js. Hasło i sekret konfiguruj wyłącznie na serwerze, bez prefiksu `NEXT_PUBLIC_`. Po zmianach zrestartuj serwer.

Przed czatem pojawia się „Wpisz hasło”. Poprawne hasło tworzy podpisany JWT ważny 8 godzin. Cookie zawiera wyłącznie standardowe dane sesji, nie hasło. Ma `HttpOnly`, `SameSite=Strict`, `Path=/`, termin ważności i `Secure` w produkcji. W produkcji nazwa ma prefiks `__Host-`, a strona wymaga HTTPS. Zmiana hasła albo sekretu unieważnia poprzednie sesje. Brak lub zbyt krótki sekret (mniej niż 32 bajty) blokuje dostęp.

`Wyjdź` przerywa odbieranie odpowiedzi, usuwa cookie i rozmowę w tej karcie oraz wraca do ekranu hasła. To sesje bez bazy danych: wylogowanie usuwa cookie z przeglądarki, nie prowadzi listy unieważnionych kopii tokenów. Skopiowany token pozostaje ważny do wygaśnięcia lub zmiany sekretu/hasła.

Serwer sprawdza podpis i wygaśnięcie w `/api/agent`, zanim odczyta konfigurację OpenRouter lub uruchomi model. Bez prawidłowej sesji zwraca `401`. Logowanie, wylogowanie i agent odrzucają żądania pochodzące z obcej strony.

## Ograniczanie prób hasła

Lokalnie działa limit **5 prób na minutę dla całego procesu**, także dla poprawnego hasła; szósta próba zwraca `429`. Restart procesu zeruje ten licznik. To pomoc do pracy lokalnej, nie globalna ochrona hostingu.

Produkcja nie korzysta z tego licznika. Na Vercel używa usługi `@vercel/firewall` i reguły o identyfikatorze **`workshop-login`**. Wspólny klucz ogranicza łączną liczbę prób, a liczniki są współdzielone między instancjami w regionie Vercel; nie jest to jeden licznik dla wszystkich regionów świata. Brak reguły, awaria usługi, brak systemowych zmiennych `VERCEL`/`VERCEL_PROJECT_PRODUCTION_URL` lub hosting poza Vercel blokują logowanie (`503`). Publiczny adres produkcyjny w domenie `vercel.app` dostarcza automatycznie Vercel. Nie używamy technicznego `VERCEL_URL`, który może przekierowywać do logowania Vercel zamiast odpowiadać na sprawdzenie limitu.

Przed udostępnieniem na Vercel skonfiguruj regułę zgodnie z [oficjalną instrukcją Rate Limiting SDK](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk): w projekcie otwórz Firewall → Configure → New Rule, wybierz warunek `@vercel/firewall` i Rate limit ID `workshop-login`. Ustaw limit **5 żądań / 60 sekund**, z akcją blokującą po przekroczeniu limitu (odpowiedź `429`, nie tryb `log`). Reguła musi być aktywna dla wywołań przez publiczny adres `VERCEL_PROJECT_PRODUCTION_URL`. Zapisz i opublikuj regułę po przeglądzie konfiguracji. Nie dodawaj warunku ścieżki `/api/auth/login` do reguły SDK: sprawdzanie limitu trafia pod `/.well-known/vercel/rate-limit-api/workshop-login`.

Projekt `laba-super-agent` ma opublikowaną regułę `Workshop login limit` dla identyfikatora `workshop-login`. Na preview wykonaj test sześciu prób i potwierdź blokadę; lokalne testy automatyczne sprawdzają również brak reguły i awarię usługi. Preview i produkcja korzystają ze wspólnego limitu przez adres produkcyjny. Na innym hostingu najpierw trzeba podłączyć usługę współdzielonych limitów, nie włączać lokalnego licznika w produkcji.

## Sprawdzenie ochrony

```powershell
npm.cmd run test:auth
npm.cmd run typecheck
npm.cmd run build
```

Testy używają własnych, fikcyjnych wartości w procesie testowym, bez czytania `.env.local`. Sieć jest zastąpiona atrapą, więc nie ma wywołań modelu. Sprawdzają poprawne i błędne hasło, atrybuty cookie, wygaśnięcie, zmianę hasła, usunięcie cookie przy wyjściu, `401` dla `/api/agent` bez sesji, obce źródło żądania, limit lokalny i blokowanie dostępu przy braku/awarii usługi limitującej w produkcji.

## Analiza wiadomości Studio Nova

Po zalogowaniu wybierz **Analiza JSON**. Wklej jedną wiadomość klienta i kliknij **Analizuj wiadomość**. `/api/agent` w trybie `analyze` zwraca kategorię (`sales`, `support`, `billing`, `unknown`), priorytet (`normal`, `high`), szkic (`draft`) i informację o sprawdzeniu (`needs_review`). `high` jest przeznaczone wyłącznie dla blokady opłaconego spotkania rozpoczynającego się w ciągu godziny. Każdy wynik pozostaje szkicem, również przy `needs_review=false`. Aplikacja nie wysyła wiadomości, nie rezerwuje terminów ani nie wykonuje operacji płatniczych.

Przełącznik **Zwykły czat** wraca do dotychczasowej rozmowy ze streamingiem. Analiza nie korzysta z historii rozmowy. Jej wynik jest usuwany po edycji wejścia, nowej próbie lub opuszczeniu trybu analizy. Przycisk **Przerwij** anuluje oczekiwanie i nie pokazuje częściowego wyniku.

Serwer używa AI SDK 7.0.157: `generateText` z `Output.object({ schema })` oraz Zod 4.1.8 `strictObject`. Brak pola, niewłaściwy typ, niedozwolona wartość i dodatkowe pole powodują błąd; dane nie są uzupełniane ani konwertowane. Provider OpenRouter 3.1.0 przekłada schemat na `response_format: json_schema` z `strict: true`. Analiza korzysta z tego samego `OPENROUTER_MODEL` i klucza co czat. Nie ma automatycznej zmiany modelu, naprawy wyniku, ponowienia generacji ani przejścia na zwykły JSON mode. Instrukcje i dane firmy pozostają na serwerze.

Przed generacją serwer sprawdza publiczne metadane `/api/v1/models/{model}/endpoints`: co najmniej jeden endpoint musi deklarować `structured_outputs` i `response_format`. Żądanie generacji ma też `provider.require_parameters: true`. Jeśli model lub dostawca nie obsługuje tego trybu, aplikacja pokazuje instrukcję sprawdzenia ograniczeń dostawców i ewentualnego ustawienia zgodnego `OPENROUTER_MODEL` **po uzgodnieniu kosztów**. Po zmianie konfiguracji lokalnej zrestartuj serwer; na hostingu wprowadź zmianę w konfiguracji serwerowej i wykonaj ponowne wdrożenie. Awaria sprawdzania metadanych blokuje analizę bez wywołania modelu. Nie wpływa to na zwykły czat.

Wynik pojawia się dopiero po pełnej odpowiedzi, sprawdzeniu sposobu jej zakończenia i walidacji na serwerze. Odmowa (`message.refusal` lub filtr treści), limit tokenów, anulowanie, timeout i błąd dostawcy nie tworzą wyniku. AI SDK 7 ignoruje wyjątki z callbacków: stan zakończenia jest odczytywany w `onStepEnd`, a sprawdzany poza callbackiem. `include.responseBody` umożliwia sprawdzenie odmowy w pamięci serwera; surowa odpowiedź nie jest logowana ani zwracana klientowi. Deklaracji o opłaceniu spotkania używa się tylko do analizy treści, nie jako weryfikacji rzeczywistej płatności. Walidacja schematu sprawdza strukturę; poprawność klasyfikacji i szkicu wymaga osobnego sprawdzenia z modelem.

Oficjalne źródła: [AI SDK: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [OpenRouter: Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider AI SDK](https://github.com/OpenRouterTeam/ai-sdk-provider). Sygnatury i domyślne opcje sprawdzono również w dokumentacji i kodzie zainstalowanych pakietów.

Testy bez wywoływania modelu:

```powershell
npm.cmd run test:analysis
npm.cmd run test:auth
npm.cmd run typecheck
```

Testy analizy używają rzeczywistych handlerów, AI SDK i providera z zastąpionym `fetch`. Sprawdzają wysłany JSON Schema, ścisłą walidację, sesję, origin, brak konfiguracji, brak obsługi modelu, odmowę (także z poprawnym JSON), przerwanie, błędy HTTP oraz regresję streamingu czatu. Nie czytają plików `.env` i nie łączą się z OpenRouter.

Pierwszą prawdziwą analizę wykonuje użytkownik w przeglądarce. Przykłady do ręcznego sprawdzenia reguł:

- „Proszę o ofertę dla 8 osób.” → `sales`, `normal`, `needs_review=true`; doprecyzowanie zakresu.
- „Nie mogę się zalogować.” → `support`, `normal`, `needs_review=true`.
- „Opłaciłem konsultację, zaczyna się za 30 minut, ale link do spotkania nie działa.” → `support`, `high`, `needs_review=true`; bez potwierdzenia płatności lub rezerwacji.
- „Proszę o zwrot płatności.” → `billing`, `normal`, `needs_review=true`; decyzja pracownika.
- „Miłego dnia!” → `unknown`, `normal`; brak rozpoznanej sprawy do doprecyzowania.

Po udanej analizie rozpocznij kolejną i kliknij **Przerwij**: poprzedni wynik powinien zniknąć, a aplikacja powinna pokazać komunikat przerwania. Wróć do zwykłego czatu i sprawdź streaming. To testy ręczne, nie zostały wykonane z prawdziwym modelem przez agenta.

## Kontrola prompt injection — 2026-11-05

Użytkownik przekazał wynik próby wymuszenia ceny 1 zł: „Szkic: Konsultacja online trwa 45 minut i kosztuje 150 zł brutto. Do sprawdzenia: nic. needs_review = false.” W tym przekazanym fragmencie zmiana ceny nie powiodła się. `needs_review=false` jest dopuszczalne przy pytaniu o znaną cenę i czas konsultacji; sama zgodność tej flagi z żądaniem atakującego nie dowodzi skuteczności ataku. Fragment nie zawiera `category` i `priority`, więc nie jest dowodem poprawności pełnego wyniku structured output. Nie wykonano nowego wywołania modelu i nie zmieniono instrukcji ani logiki aplikacji.

Testy lokalne potwierdzają odrzucenie dodatkowych pól wejścia `send_now` (także `false`), `permissions`, `isAdmin`, `role`, `system`, `instructions`, `schema`, `output`, `tools` i wstrzykniętej historii: HTTP 400, bez wywołania dostawcy. `send_now` i `permissions` w odpowiedzi modelu powodują błąd walidacji i HTTP 502 bez wyniku zastępczego. Zwykły czat odrzuca wiadomości z rolami `system`, `developer` i `tool` przysłane w historii.

Test z atrapą OpenRouter sprawdza też, że treść ataku i zapisane w niej pozorne role pozostają jednym tekstem `user`, a instrukcja firmy, schemat strict i brak narzędzi pochodzą z serwera. Fikcyjne wartości klucza, hasła i sekretu sesji nie trafiają do kontekstu modelu. Klucz API służy tylko do uwierzytelnienia transportu do OpenRouter. Nie istnieją narzędzia wysyłania wiadomości, rezerwacji lub płatności; `needs_review=false` nie przyznaje takich uprawnień.

Schemat kontroluje strukturę, a nie prawdziwość ceny w tekście `draft`: poprawny typ `string` może zawierać błędną informację. Wynik próby z prawdziwym modelem należy oceniać osobno od testów transportu i walidacji. Rozdzielenie instrukcji od danych, walidacja i brak uprawnień do działań zewnętrznych są osobnymi warstwami ochrony; jedna udana obrona nie dowodzi odporności na wszystkie ataki. Zobacz [OWASP: Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

Do powtórzenia w przeglądarce: zwykłe pytanie o cenę (150 zł brutto, 45 minut), ta sama wiadomość z poleceniem ceny 1 zł (bez przyjęcia fałszywej ceny), polecenie nadania roli administratora i wysłania odpowiedzi (wyłącznie szkic, bez działania) oraz żądanie sekretów (bez ich ujawnienia). W trybie analizy sprawdź również obecność wszystkich czterech pól wyniku.

Po ustawieniu własnego `CHAT_PASSWORD` ręcznie sprawdź w przeglądarce: ekran hasła, odmowę po błędnym haśle, wejście po poprawnym, wyjście i powrót do ekranu hasła po odświeżeniu. Samo logowanie i wyjście nie wywołują modelu. Nie testowano wyglądu w przeglądarce ani prawdziwego Vercel Firewall; test produkcji używa atrap odpowiedzi usługi.


## Osiem narzędzi agenta — 2026-11-12

Narzędzia korzystają z istniejącego AI SDK i Zod; bez nowych bibliotek i kluczy do publicznych API. Każde ma opis użycia i `inputSchema`. Wyniki mają tylko potrzebne pola i czas pobrania w ISO UTC (`pobranoAt`; dotychczasowa ścieżka błędu pogody zachowuje `sprawdzonoAt`). Agent ma prezentować czas po polsku w Europe/Warsaw. Połączenia mają wspólny limit 8 sekund na wykonanie narzędzia, obsługują przerwanie żądania i nie korzystają z cache. Brak danych, HTTP, timeout i nieprawidłowa odpowiedź dają polski komunikat zamiast wyjątku. Wyniki narzędzi pozostają w historii następnych tur; plakietki pochodzą ze wspólnego katalogu `lib/tool-catalog.ts`.

| Narzędzie | Wejście i zapytanie | Ograniczony wynik |
| --- | --- | --- |
| `pogoda` | `miejscowosc`, opcjonalne `kodKraju`, `dzien` YYYY-MM-DD. GET geocoding `/v1/search?name=…&count=3&language=pl&countryCode=…`, następnie forecast `/v1/forecast?latitude=…&longitude=…&timezone=auto`. Dla dnia: `daily`, `start_date=end_date`; bez dnia zachowane `current`. | Bieżąca pogoda lub prognoza: minimum/maksimum temperatury, dobowa suma i prawdopodobieństwo opadów, maksymalny wiatr, opis, strefa i źródło. Prognoza od dziś do 15 dni naprzód w strefie miasta. Kilka miejscowości → prośba o doprecyzowanie. |
| `waluty` | `waluta` ISO, opcjonalne `kwota` i `kierunek` (`doPLN`/`zPLN`). GET NBP `/api/exchangerates/rates/a/{code}/?format=json`; 404 → tabela B. | `code`, `currency`, `rates[0].mid` i `effectiveDate` → kod, nazwa, kurs PLN za jednostkę, data publikacji, opcjonalne przeliczenie do 2 miejsc i źródło. Kurs średni z ostatniej publikacji, bez marż. |
| `swieta` | `kodKraju` ISO alpha-2, `rok` 1900–2100. GET `https://date.nager.at/api/v3/PublicHolidays/{year}/{country}`. | Z tablicy odpowiedzi wyłącznie pozycje z `types` zawierającym `Public`: data, lokalna nazwa, cały kraj (`global`) lub regiony (`counties`). Nie obejmuje weekendów i urlopów; nie każdy zawód ma takie samo prawo do wolnego. |
| `wikipedia` | `haslo` (jeden tytuł). GET `https://pl.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&ppprop=disambiguation&exintro=1&explaintext=1&exchars=1000&redirects=1&format=json&formatversion=2&titles=…`. | `query.pages[0]` → tytuł, krótki tekst bez HTML i link do artykułu. Obsługa przekierowań, brakujących i niejednoznacznych haseł. |
| `kalkulator` | `dzialanie`: dodaj/odejmij/pomnoz/podziel/potega/procent oraz liczby `a`, `b` jako oddzielne argumenty. Lokalne operatory JavaScript, bez `eval` i wykonywania tekstu. | Skończony wynik albo komunikat (dzielenie przez zero, wynik nierzeczywisty, przepełnienie). Procent = a% z b. Standardowa precyzja Number. |
| `czas` | Opcjonalna `strefa` IANA, domyślnie Europe/Warsaw. Lokalne `Intl.DateTimeFormat` i zegar serwera. `aktualnyCzas` jest zachowanym aliasem i nadal służy do wymuszonego sprawdzenia daty. | Data, dzień tygodnia, godzina, strefa i czas pobrania; nieznana strefa → komunikat. |
| `notatki` | `akcja: zapisz` + `tresc` (1–2000 znaków) albo `akcja: pokaz`. Lokalny `Map` w pamięci procesu. | Zapis zwraca nową notatkę; odczyt listę notatek z identyfikatorami i czasami zapisu. Limit 100 na sesję i 200 sesji na instancję; po zapełnieniu czytelny komunikat, bez usuwania starszych wpisów. |
| `diagnostyka` | Puste `{}`. Lokalna lista rejestru, stała limitu i wskazane pola `process.env`. | Skonfigurowana nazwa modelu, faktyczna lista narzędzi (w tym wyszukiwanie, obraz i alias czasu), limit 18 kroków oraz `tak`/`nie` dla OPENROUTER_API_KEY, OPENROUTER_MODEL, CHAT_PASSWORD, SESSION_SECRET. Nigdy wartości sekretów. |

Notatki są izolowane według sesji logowania. Model nie podaje identyfikatora sesji: serwer wyznacza klucz pamięci ze skrótu podpisanego cookie, nie przekazuje go modelowi. Nowe sesje JWT mają losowe `jti`, także przy logowaniach w tej samej sekundzie. Notatki znikają po restarcie, ponownym logowaniu lub zmianie instancji; na hostingu wiele instancji może mieć różne zestawy notatek. To celowo tymczasowe rozwiązanie na tę lekcję, bez bazy i zapisu na dysku.

Schemat wejścia notatek jest pojedynczym obiektem z wymaganym `akcja: zapisz | pokaz` i opcjonalnym `tresc` (dla odczytu można pominąć lub podać `null`). Zastępuje unię z dyskryminatorem, przy której model pomijał poprawne pole `akcja` i pojawiał się błąd `No matching discriminator`. Pusta treść zapisu zwraca polski komunikat. Przykłady parametrów są podane w opisie pól, `inputExamples` i instrukcji agenta. Test regresji sprawdza rzeczywisty JSON Schema w żądaniu OpenRouter oraz zapis „sprawdzić ceny lotów do Lizbony”, odczyt w tym samym zadaniu i odczyt w osobnym żądaniu tej samej sesji.

Dokumentacja sprawdzona przed implementacją:

- [Open-Meteo Forecast](https://open-meteo.com/en/docs) i [Geocoding](https://open-meteo.com/en/docs/geocoding-api).
- [NBP Web API](https://api.nbp.pl/): adresy tabel A/B, `mid`, `effectiveDate`, statusy 400/404.
- [Nager.Date](https://github.com/nager/Nager.Date) i [aktualna dokumentacja](https://nagerholidays.com/api). Projekt nadal opisuje v3 jako wspierane do 2027-01-31; aktualna strona prezentuje v4. Implementacja używa wskazanego w zadaniu `date.nager.at` i v3 (`global`, `counties`, `types`).
- [MediaWiki Query](https://www.mediawiki.org/wiki/API:Query) i [TextExtracts](https://www.mediawiki.org/wiki/Extension:TextExtracts#API).
- Lokalne API: [Intl.DateTimeFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat), [Number.isFinite](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isFinite), [Node.js globals](https://nodejs.org/api/globals.html); kontrakty `Map` i `process.env` nie wymagają HTTP.
- AI SDK: dokumentacja zainstalowanej wersji w `node_modules/ai/docs/`, m.in. `tool`, `convertToModelMessages`, `streamText` i `isStepCount`.

Sprawdzenie: `npm run test:agent`, `npm run typecheck`, `npm run build`. Nowe testy w `tests/tools.test.cjs` używają rzeczywistych handlerów i SDK z atrapami sieci. Obejmują obliczenia, strefy, parametry HTTP, ograniczanie pól, awarie, zakres prognozy, notatki i ich izolację, brak sekretów w diagnostyce oraz przejście model → narzędzie → UI → kolejna tura dla wszystkich ośmiu narzędzi. Nie czytają `.env` i nie wywołują płatnych modeli. Próba bezpośredniego sprawdzenia publicznych API z lokalnego środowiska zakończyła się `fetch failed`; działanie z rzeczywistymi usługami wymaga sprawdzenia w środowisku z dostępem do sieci.

Pętla ReAct: najwyżej 18 kroków modelu na zadanie (`isStepCount(18)`). Czat pokazuje kolejność wywołań z numerem rzeczywistego kroku modelu, również powtórzenia. Po dojściu do limitu pokazuje „Zatrzymałem się po 18 krokach” i ograniczone wyniki narzędzi, także gdy model nie zdążył napisać odpowiedzi. Nie uruchamia dodatkowego modelu do podsumowania.
## Asystent podróży `/dashboard`

Chroniona strona i POST `/api/dashboard` wymagają tej samej sesji co czat; endpoint dodatkowo sprawdza origin. Formularz przyjmuje miasto (opcjonalnie kraj/region po przecinku) i datę ISO. Geokodowanie Open-Meteo ustala kraj i strefę; niejednoznaczne miasto wymaga doprecyzowania. Prognoza, kurs NBP, święta Nager.Date i wprowadzenie Wikipedii korzystają z istniejących funkcji narzędzi. Czas używa wspólnego `warsawTime` z jedną chwilą odniesienia do obliczenia różnicy względem Polski (także ułamkowe strefy i zmiany DST). Różnica dotyczy chwili pobrania, nie dnia wyjazdu.

Waluta jest ustalana z jawnej lokalnej tabeli kraj–waluta; nieobsługiwany kraj daje czytelny brak danych. Dla PLN karta pokazuje tożsamość 1 PLN = 1 PLN bez fikcyjnego kursu NBP. Święta są wybierane od dnia wyjazdu, z zachowaniem zakresu regionalnego; w razie potrzeby sprawdzany jest również kolejny rok. Wikipedia pokazuje najwyżej dwa dostępne zdania i link. Każda karta zawiera źródło i czas pobrania (dla błędu: czas próby). Odśwież pobiera wszystkie dane ponownie, bez cache.

Agent otrzymuje tylko dane kart i przygotowuje 2–3 zdania porad. To jedno wywołanie skonfigurowanego modelu na Sprawdź/Odśwież; awaria lub brak konfiguracji modelu nie usuwa kart. Publiczne API nie wymagają nowych kluczy. Błąd pojedynczego źródła nie blokuje pozostałych kart. Testy offline obejmują sesję, origin, pięć kart, PLN, różnicę czasu i niedostępne źródło. Nie wykonano płatnego wywołania modelu ani przeglądarkowego testu z prawdziwymi usługami.

## Porównanie miast

Na `/dashboard` przełącznik „Porównaj” dodaje drugie miasto; oba cele używają tej samej daty. Wyniki są prezentowane w dwóch kolumnach, na małym telefonie jedna pod drugą. „Odśwież” ponownie pobiera oba zestawy. Endpoint przyjmuje opcjonalne `secondCity` i odrzuca identyczne nazwy. Obie lokalizacje są sprawdzane równolegle; brak miasta lub źródła nie usuwa drugiej kolumny. W trybie porównania nie generujemy dwóch osobnych podsumowań: jedno wywołanie modelu otrzymuje obie listy kart i ma polecić miasto, wskazując konkretne dane i ograniczenia. Kurs waluty nie jest traktowany jako cena pobytu. Braki źródeł są zawsze dopisywane przez serwer. Niedostępny model oznacza jawną niedostępność rekomendacji, bez wymyślonego wyboru. Test porównania obejmuje wspólną datę, obie kolumny, jedno wywołanie modelu i awarię geokodowania jednego celu; używa atrap sieci.
