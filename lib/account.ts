// To, co nagłówek pokazuje o zalogowanej osobie. Pochodzi z tokenu zweryfikowanego na serwerze;
// służy tylko do wyświetlania, nigdy do decyzji o dostępie.
export type AccountSummary = {
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

// Pola, które Supabase Auth zapisuje w user_metadata dla kont Google (imię i zdjęcie).
// Konto e-mail ich nie ma — wtedy nagłówek pokazuje e-mail bez avatara.
const NAME_FIELDS = ["full_name", "name"] as const;
const AVATAR_FIELDS = ["avatar_url", "picture"] as const;

function firstString(metadata: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) {
    const value = metadata[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// user_metadata może zmienić sam użytkownik, więc przyjmujemy tylko krótkie imię i adres https.
export function accountFromClaims(email: string | null, metadata: unknown): AccountSummary {
  const data = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const name = firstString(data, NAME_FIELDS);
  const avatar = firstString(data, AVATAR_FIELDS);
  let avatarUrl: string | null = null;
  try {
    if (avatar && avatar.length <= 2048 && new URL(avatar).protocol === "https:") avatarUrl = avatar;
  } catch {
    avatarUrl = null;
  }
  return { email, name: name ? name.slice(0, 100) : null, avatarUrl };
}
