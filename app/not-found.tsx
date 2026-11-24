import Link from "next/link";

// Wspólna strona 404: nieistniejący adres albo rozmowa innej osoby. Bez żadnych danych.
export default function NotFound() {
  return (
    <main className="chat">
      <h1>Nie znaleziono</h1>
      <p>Ta strona albo rozmowa nie istnieje lub nie należy do Twojego konta.</p>
      <p><Link href="/?new=1">Zacznij nową rozmowę</Link> · <Link href="/history">Historia</Link></p>
    </main>
  );
}
