# Kolejne przykłady JPEG XR — naprawa regresji

Zgłoszenie: Chrome na Windows, po zmianie przykładu komunikat `JPEG XR pixel 48909 has alpha outside [0, 1]`. Punkt odniesienia: commit `518adf3`.

## Przyczyna

Backend `jpegxr` 0.3.0 deklaruje układ RGBA, ale jego wrapper wywołuje `Copy` z domyślnym `uAlphaMode=0`, bez dekodowania alfa. Miejsca alfa w buforze wyjściowym zawierają poprzednią zawartość pamięci WASM. Świeża instancja zazwyczaj zwraca tam zera; po przejściu między obrazami half-float i float pojawiają się również wartości spoza zakresu, NaN i Infinity. Dodana wcześniej ścisła walidacja alfa ujawniła ten problem jako błąd importu.

Na plikach z repo odtworzono sekwencję Ghost → Forza → Ghost. SHA-256 kanałów RGB Ghosta pozostaje identyczny, podczas gdy wartości alfa zmieniają się. To nie jest problem gamutu ani ekspozycji i nie wymaga obcinania HDR RGB.

Źródła backendu: [wrapper C](https://github.com/bvibber/jpegxr/blob/main/wasm/wasm_api.c), [warunek dekodowania alfa w JXRGlue](https://github.com/bvibber/jpegxr/blob/main/jxrlib/jxrgluelib/JXRGlueJxr.c). Faktyczne zachowanie potwierdzono również na zainstalowanym pakiecie 0.3.0.

## Zmiana

- Adapter tego backendu nie odczytuje niedekodowanych miejsc alfa. Zwraca jawnie nieprzezroczysty obraz, `sourceAlphaDecoded: false` i ostrzeżenie. RGB jest zachowane.
- Nie naprawiamy dowolnych danych przez clamp. Walidacja niepoprawnego RGB oraz rzeczywiście zdekodowanej alfa pozostaje aktywna. JXR premultiplied wymagający niedostępnej alfa kończy się jawnym błędem.
- Przykłady zachowują nazwę pliku przy przekazaniu pobranego Blobu do dekodera. Wybór JXR nie zależy od typu MIME zwróconego przez hosting.
- Spóźnione `error` / `messageerror` z anulowanego workera są ignorowane, jeśli slot ma już innego workera.

Pełne zachowanie przezroczystości JXR wymaga backendu, który rzeczywiście dekoduje alfa. Obecna naprawa przywraca pewne ładowanie i eksport nieprzezroczystych screenshotów, z widocznym ostrzeżeniem o tym ograniczeniu.

## Weryfikacja

- `npm run check`: 76/76 testów, bez pominiętych; lint poprawny.
- Testy obejmują niepoprawne bajty niedekodowanej alfa, zachowanie prawidłowej zerowej alfa, odrzucenie niepoprawnego RGB i premultiplied oraz spóźnione błędy poprzedniego workera.
- Test integracyjny wykonuje sześć kolejnych importów prawdziwych JXR-ów 4K, zmieniając half-float / float i sprawdzając identyczny wynik powtórnego importu. Bez opcjonalnego datasetu pomijany jest tylko ten test; małe regresje nie wymagają datasetu.
- Wszystkie 12 JXR-ów z manifestu przykładów przechodzą kolejny import przez publiczną usługę dekodowania, również przy MIME `application/octet-stream`: [wyniki](jxr-examples-after.json).
- Gotowy build Pages sprawdzono w Chromium: Forza 1 → Ghost 1 → Forza 2 → Indiana Jones 1 → Neverness 1 → Battlefield AVIF. Metadane potwierdzają kolejne obrazy; przejście Ghost po Forzie nie zgłasza błędu alfa.
- Czysta sesja buildu Pages: Forza 1 → Ghost 1 → Forza 2 → Ghost 1, bez błędów konsoli.

Nie wykonano testu na Windows. Przyczynę odtworzono na tym samym backendzie WASM w Node i Chromium na macOS. Wyniki poprzedniej weryfikacji pozostają historycznym zapisem sprzed tej poprawki.
