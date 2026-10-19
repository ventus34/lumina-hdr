# Lumina HDR — wdrożenie napraw po audycie

Data: 19 października 2026. Punkt odniesienia: `f984d56263d0cb169ac014eaa0dc172120a4ea3d`.

Raport opisuje wdrożone zmiany i ich weryfikację. [Pierwotny audyt](2026-10-19.md) oraz jego wyniki pozostają zapisem stanu przed naprawami. Generowany katalog `dist/` jest ignorowany przez Git; opublikowany punkt wejścia Pages, `docs/index.html`, pozostaje wersjonowany.

Pracę rozdzielono między subagentów odpowiedzialnych za kodeki, kolory i eksport, integrację aplikacji, wydajność, narzędzia i dystrybucję oraz dostępność. Integracja obejmowała dodatkowy przegląd i testy rzeczywistych ścieżek przeglądarkowych. Poniższa tabela opisuje wdrożone rozwiązania; nie oznacza certyfikacji wszystkich formatów, przeglądarek ani wyświetlaczy HDR.

## Zakres napraw

| Ustalenie | Wdrożone rozwiązanie | Dowód / ograniczenie |
| --- | --- | --- |
| A01: nieliniowe SDR | Dokładne sRGB EOTF/OETF, liniowa przestrzeń Rec.709, alfa poza transformacją. Domyślna gamma 2.2 oznacza neutralne sRGB; regulacja artystyczna pozostaje ciągła. | Rampa GPU ma kody 0, 10, 118, 188, 255; rzeczywisty PNG import → eksport różni się najwyżej o 1 kod 8-bitowy. |
| A02: AVIF HDR / gamut | Metadane powiązane z głównym elementem BMFF, backend WASM `@jsquash/avif` z próbkami high-bit, konwersja primaries do liniowego Rec.709. PQ zachowuje absolutne nity; HLG używa OOTF dla wyświetlacza referencyjnego 1000 nitów. Osobne `sourceHDR`, `sourceHDRKnown`, `decodedHDR` i ostrzeżenia o fallbacku. | Rzeczywiste 10-bitowe AVIF PQ i HLG sprawdzone liczbowo w przeglądarce. Brak metadanych nie jest przedstawiany jako pewne SDR. HLG przyjmuje jawny referencyjny peak i gamma 1.2. |
| A03: możliwości HDR | Próbne ustawienie i odczyt przestrzeni bufora, obsługa wyjątków, rozdzielenie wsparcia API od wyświetlacza, wyłączenie niedostępnej opcji. Eksport jest niezależny od kontekstu podglądu. | W badanej przeglądarce niedostępny native HDR jest wyłączony, bez wyjątku. Fizycznego wyjścia HDR nie zweryfikowano. |
| A04: zawieszone operacje | Rozliczanie błędów natywnych dekoderów i Canvas, sprzątanie zasobów, obsługa `toBlob(null)`, anulowanie, timeouty oraz `finally` w batch. | Regresje błędów readbacku, abortu, timeoutu i odtwarzania puli workerów przechodzą. Natywny kodek przeglądarki może kończyć pracę po odrzuceniu anulowanej operacji; rezerwacja pamięci pozostaje do jego zakończenia. |
| A05: DOM injection | Wiersze batch budowane przez DOM, nazwy i komunikaty przypisywane jako tekst / właściwości. | Kontrola implementacji i testy obsługi interfejsu; brak interpolacji nazwy pliku jako HTML. |
| A06: rozbieżny eksport | Wspólne usługi dekodowania i eksportu dla viewer/batch, wspólna matematyka CPU, porównanie z GLSL, jawny oryginał / korekcje w RGBE, poprawione punkty kotwiczące Lottes. Stała skala linear PNG, metadane sRGB/cICP/sBIT, PQ niezależne od ustawienia bieli dla danych absolutnych. | Sześć operatorów CPU PNG16 / GPU: największa różnica kanału 0.001862. Testy PNG analizują chunk i zdekompresowane próbki; RGBE przechodzi pełny round-trip. |
| A07: alfa | Jawne zachowanie: zachowaj, spłaszcz na białym, wymuś nieprzezroczystość. Brak globalnej heurystyki zmieniającej zerową alfę. UI wyjaśnia ograniczenia JPEG/RGBE. | Testy zerowej alfa, PNG 8/16-bit oraz przełączania formatu i przywracania preferencji. |
| A08: uszkodzone pliki | Walidacja wymiarów, budżetu, układu, długości i skończoności danych. RGBE: truncation, RLE stare/nowe, orientacje i jawne odrzucenie XYZE. EXR: grayscale i chromaticities. JXR: obsługiwane układy i grayscale, jawne błędy innych wariantów. | Regresje kodeków i rzeczywisty JXR 4K. Biblioteka JXR nie udostępnia pełnych profili: założenia interpretacji są sygnalizowane. Brak pełnego fuzzingu binarnych kodeków. |
| A09: wyścigi i stan | Żądania z abortem i zasadą ostatniego wyboru, zatwierdzanie obrazu dopiero po udanym uploadzie GPU, własność loadingu, snapshot ustawień batch i sprawdzenie anulowania przed pobraniem. | Testy latest-wins i transakcyjnego zatwierdzania obrazu; wspólne ścieżki pliku, przykładów i scen syntetycznych. |
| A10: responsywność / pamięć | Ograniczona pula workerów, odroczone kopie transferowe, wspólne przetwarzanie i kodowanie, anulowanie przez zakończenie workera, budżety wejścia/wyjścia, jeden decode naraz, kontrola GPU, rAF, cache i obsługa utraty kontekstu. | Testy kolejki, budżetów, timeoutów, anulowania i cleanup. Symulowana utrata WebGL przywraca teksturę. [Raport wydajności](../performance.md) opisuje limity; nie jest to twardy limit RSS całego procesu. Benchmark 8K i pomiar szczytowej pamięci przeglądarki pozostają niewykonane. |
| A11: brak regresji / CI | Node 24.19, ESLint, testy Node, małe wzorce AVIF, ręczny harness WebGL oraz GitHub Actions dla instalacji, kontroli, obu buildów i audytu npm. | Lokalnie 72/72 testy i lint bez błędów; harness przeglądarkowy 15/15. Zdalny workflow uruchomi się po wysłaniu zmian. |
| A12: zależności | Aktualizacja narzędzi i lockfile, audyt po dodaniu backendu AVIF. | Świeże `npm audit --json`: 0 zgłoszeń we wszystkich poziomach; [pełny wynik](dependencies-after.json). Nie jest to dowód braku usterek własnego kodu lub WASM. |
| A13: dystrybucja | Osobne portable / Pages, systemowe fonty, osadzone WASM, wyłączone zewnętrzne przykłady w portable, walidacja 22 wpisów datasetu Pages. Teksty licencji zależności osadzone w HTML. | Oba buildy przechodzą. Gotowy portable HTML uruchomiony przez localhost i otworzył PQ AVIF jako HDR, 990 nitów. Bezpośredni test `file://` nie został wykonany: polityka narzędzia przeglądarkowego dopuszcza tylko HTTP/HTTPS. Dataset pozostaje w repo; historii Git nie przepisano. |
| A14: dostępność / mobile | Semantyczne zakładki, przyciski i akordeony, etykiety, statusy live, focus, klawiatura, Pointer Events, sterowanie zoom/pan/podziałem, zwijane kontrolki, responsywność i reduced motion. Poprawiona geometria HUD, drag i zoomu względem kursora. | Testy matematyki viewportu i semantyki UI. Kontrola przy 390×844: brak poziomego przepełnienia, przewijany panel i dostępny podgląd. Usunięto nakładanie tekstu instrukcji na etykiety. Brak pełnego audytu WCAG/czytnika ekranu; histogram ma nazwę, lecz nie tekstowe zestawienie koszyków. |
| A15: utrzymanie | Wydzielone moduły koloru, usług, workerów, metadanych, dostępności, żądań i geometrii; usunięty szablon Vite, poprawione credits i instrukcje. | `main.js` nadal zawiera integrację DOM i ustawienia; dalsze dzielenie modułów może być osobnym zadaniem. Nie wprowadzano nowego frameworka. |

## Końcowa weryfikacja

Zbiorczy zapis pomiarów, rozmiarów i SHA-256 artefaktów: [verification-after.json](verification-after.json).

- Czysta instalacja: `npm ci --ignore-scripts --no-audit` zakończona poprawnie po wszystkich zmianach zależności.
- `npm run check`: lint poprawny, **72 testy przechodzą**, zero pominiętych / nieudanych.
- `tests/browser/pipeline.html` na Chromium 155 w przeglądarce wbudowanej: **15 sprawdzeń przechodzi**. Obejmuje rzeczywisty Canvas, WebGL, eksporty przez workery, PQ/HLG WASM i utratę kontekstu.
- PQ kod 512: oczekiwane 92.698 nitów, odczytane 92.705. PQ kod 768: 990.014 / 989.973. HLG kod 512: 50.816 / 50.818. Próbki i sposób wygenerowania opisuje [README fixtures](../../tests/fixtures/README.md).
- `npm run build:portable`: jeden `dist/index.html`, około **4.01 MB**, gzip **1.25 MB**. Wzrost względem starego builda wynika głównie z backendu WASM zachowującego HDR AVIF.
- `npm run build:pages`: walidacja 22 przykładów i wygenerowanie `docs/index.html`; dataset nie jest kopiowany ponownie.
- `npm audit`: **0 podatności**. `git diff --check`: poprawny.

Build nadal wypisuje ostrzeżenia Vite o `fs` / `path` w gałęzi Node biblioteki `jpegxr`. Ścieżka przeglądarkowa nie potrzebuje tych modułów; rzeczywisty decode JXR i build działają. Nie dodawano atrap modułów Node ukrywających potencjalny błąd wykonania.

## Weryfikacja wymagająca osobnego środowiska

Nie potwierdzono fizycznego wyjścia native HDR, zgodności całej macierzy Safari / Firefox / Edge, działania bezpośrednio z `file://`, pełnej dostępności czytnikiem ekranu, 8K peak memory ani pełnego fuzzingu WASM. To granice przeprowadzonej weryfikacji, a nie wyniki pozytywne. Przed wydaniem warto wykonać te kontrole na docelowych urządzeniach, szczególnie dla eksperymentalnego natywnego HDR.

## Powtórzenie kontroli

```sh
npm ci
npm run check
npm run build:portable
npm run build:pages
npm run audit
npm run dev
# Otwórz /tests/browser/pipeline.html na lokalnym serwerze.
```

`node docs/audit/reproduce.mjs` uruchamia obecny zestaw regresji. Historyczne `results.json` i `reproduce-baseline.mjs` celowo nadal opisują błędy pierwotnego commita.
