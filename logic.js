/*
 * Reine Kategorisierungs-/Tag-Logik des Haushaltsbudget-Trackers, ausgelagert aus index.html,
 * damit sie sowohl von der App (per <script src="logic.js">) als auch von tests.js (per
 * require(), ohne DOM) ohne Duplikation genutzt werden kann. Enthält bewusst keinen DOM-,
 * localStorage- oder Netzwerk-Zugriff — Funktionen, die gespeicherten State (gelernte
 * Kategorien/Tags) brauchen, bekommen ihn als expliziten Parameter statt aus einer Closure.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BudgetLogic = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  const CATEGORIES = [
    "Wohnen", "Lebensmittel", "Restaurants", "Gesundheit & Apotheke", "Versicherungen",
    "Mobilität", "Kinder", "Aus-/Weiterbildung", "Kleidung", "Reisen & Freizeit",
    "Abos", "Steuern", "Spenden", "Einkommen", "Vorsorge & Anlagen",
    "Kreditkarte (Sammelbuchung)", "Diverses"
  ];
  const TRANSFER_CATEGORIES = ["Transfer: Haushalt → Sparkonto", "Transfer: Sparkonto → Haushalt"];
  const ALL_CATEGORY_OPTIONS = CATEGORIES.concat(TRANSFER_CATEGORIES);

  // --- Private Sparkonto-Transfers per Namensregel ---------------------------------------
  //
  // Konsolidierte, einzige Regel für private (nicht gegenseitig einsehbare) Sparkonto-Transfers.
  // Ersetzt alle früheren Einzel-Patches zu diesem Thema. Läuft mit höchster automatischer
  // Priorität (Stufe 2 von 6, siehe resolveInitialCategorization()) — blockiert ausnahmslos
  // die "Mitglieder Sparkonto"-Texterkennung, jede andere automatische Texterkennung UND
  // gelerntes Mapping, auch wenn dafür ein (jetzt falscher) alter Lern-Eintrag existiert.
  //
  // Einzige Quelle der Wahrheit für die Erwachsenen- und Kindernamen — wird sowohl hier
  // (Namensregel) als auch bei der Tag-Ableitung (siehe deriveKeywordTag()) verwendet, damit
  // beide Stellen nie auseinanderlaufen.
  const ADULT_TRANSFER_NAMES = ["Monika Keller", "Lukas Emanuel Keller", "Lukas Emanuel und Monika Keller"];
  const CHILD_NAMES = ["Deborah", "Eva", "Lisa", "Rebekka"];

  // Kindernamen kommen in den Bankdaten teils in umgekehrter Reihenfolge vor (Nachname zuerst,
  // z.B. "Keller Rebekka" statt "Rebekka Keller") — daher beide Reihenfolgen aufnehmen.
  const CHILD_TRANSFER_NAME_PATTERNS = CHILD_NAMES.reduce((patterns, name) => patterns.concat([name + " Keller", "Keller " + name]), []);

  const PRIVATE_TRANSFER_NAMES = ADULT_TRANSFER_NAMES.concat(CHILD_TRANSFER_NAME_PATTERNS);

  // Whitespace-tolerant (mehrfache/wechselnde Leerzeichen vereinheitlicht) und case-insensitiv.
  function normalizeForNameMatch(s) {
    return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  const NORMALIZED_PRIVATE_TRANSFER_NAMES = PRIVATE_TRANSFER_NAMES.map(normalizeForNameMatch);
  const NORMALIZED_ADULT_TRANSFER_NAMES = ADULT_TRANSFER_NAMES.map(normalizeForNameMatch);
  const NORMALIZED_CHILD_TRANSFER_NAME_PATTERNS = CHILD_TRANSFER_NAME_PATTERNS.map(normalizeForNameMatch);
  const NORMALIZED_CHILD_NAMES = CHILD_NAMES.map(normalizeForNameMatch);

  // Jugendlohn ist eine reguläre Ausgabe, keine Sparbewegung — auch wenn im selben Text ein
  // Kind-/Elternname vorkommt (z.B. "Dauerauftrag Keller Rebekka / Jugendlohn CHF 75.00" enthält
  // sowohl "Keller Rebekka" als auch "Jugendlohn"). Diese Ausnahme wird VOR der Namensregel
  // geprüft und hat Vorrang vor ihr, siehe resolveInitialCategorization().
  function containsJugendlohnKeyword(mainText, details) {
    const combined = normalizeForNameMatch((mainText || "") + " " + (details || ""));
    return combined.indexOf("jugendlohn") !== -1;
  }

  // "Bezahlt für: <Name(n)>" referenziert nur die betroffene(n) Person(en), ist aber KEIN
  // Hinweis auf einen privaten Sparkonto-Transfer, wenn der/die Name(n) NUR dort auftauchen —
  // der tatsächliche Empfänger im Haupttext ist dann eine externe Firma/Institution, z.B.
  // "Zahlung Schweizerische Mobiliar Versicherungsgesellschaft AG ... Bezahlt für: Monika Keller".
  // Taucht derselbe Name AUCH ausserhalb dieses Musters auf (z.B. als Haupttext-Empfänger selbst
  // oder direkt in einer Dauerauftrag-Detailzeile ohne "Bezahlt für:"), bleibt es ein echter
  // Treffer — daher: das gesamte "Bezahlt für:"-Feld herausfiltern und erst DANACH prüfen, ob
  // ein Name noch irgendwo übrig bleibt. Das Feld endet in der Praxis erst beim nächsten Betrag
  // ("chf ...") oder am Textende — alles dazwischen ist reine Namensreferenz, auch wenn dort
  // (wie bei gemeinsamer Steuerveranlagung) mehrere Personen genannt werden, z.B.
  // "Bezahlt für: Lukas Keller Monika Keller".
  function stripBezahltFuerReferences(normalizedCombined) {
    return normalizedCombined.replace(/bezahlt für:?.*?(?=chf|$)/g, " ");
  }

  // "Enthält", nicht "beginnt mit" — der Name steht in der Praxis fast nie ganz vorne, sondern
  // hinter Präfixen wie "Gutschrift"/"Zahlung"/"Dauerauftrag" oder erst in den Detailzeilen.
  //
  // Name allein reicht NICHT mehr — es braucht zusätzlich ein zum Namenstyp passendes
  // Signalwort (siehe hasMatchingTransferSignalWord(), das dieselbe requiresName-Gruppierung
  // wie die Tag-Ableitung wiederverwendet). Bug-Fund: "Zahlung Keller Rebekka / Mehl CHF 1.90"
  // bekam bisher fälschlich "Transfer: Haushalt → Sparkonto", obwohl kein Signalwort vorkommt —
  // der Name allein war nie ein zuverlässiger Beleg für einen tatsächlichen Sparkonto-Transfer
  // (Kinder können z.B. eine eigene Debitkarte für ganz normale Alltagseinkäufe haben).
  function containsPrivateTransferName(mainText, details) {
    const combined = normalizeForNameMatch((mainText || "") + " " + (details || ""));
    if (!NORMALIZED_PRIVATE_TRANSFER_NAMES.some((name) => combined.indexOf(name) !== -1)) {
      return false;
    }
    const withoutBezahltFuer = stripBezahltFuerReferences(combined);
    const isAdultNameMatch = NORMALIZED_ADULT_TRANSFER_NAMES.some((name) => withoutBezahltFuer.indexOf(name) !== -1);
    const isChildNameMatch = NORMALIZED_CHILD_TRANSFER_NAME_PATTERNS.some((name) => withoutBezahltFuer.indexOf(name) !== -1);
    if (!isAdultNameMatch && !isChildNameMatch) return false;
    return hasMatchingTransferSignalWord(combined, isAdultNameMatch, isChildNameMatch);
  }

  // Kategorie wird rein aus dem Vorzeichen abgeleitet, sobald Name UND passendes Signalwort
  // feststehen — das Vorzeichen allein entscheidet nur noch die Richtung, nicht mehr OB es
  // überhaupt ein Transfer ist (das übernimmt containsPrivateTransferName()).
  function resolvePrivateTransferCategory(amount) {
    if (amount === null) return null;
    return amount < 0 ? "Transfer: Haushalt → Sparkonto" : "Transfer: Sparkonto → Haushalt";
  }

  // Kurzform-Muster bei "Mitglieder Sparkonto"-Überträgen: der Verwendungszweck nennt die
  // Erwachsenen dort oft ohne Nachname und mit "&" statt "und" (z.B. "Säule 3a Monika & Lukas
  // CHF 3'000.00"), teils sogar ohne Leerzeichen um das "&" ("Monika&Lukas"). Diese Mehrwort-
  // Kombination ist spezifisch genug, um unbedingt (nicht nur im Mitglieder-Sparkonto-Kontext)
  // als Namenstreffer zu zählen.
  const ADULT_SHORT_NAME_PATTERNS = [
    /monika\s*&\s*lukas/,
    /lukas\s*&\s*monika/,
    /monika\s+und\s+lukas/,
    /lukas\s+und\s+monika/
  ];

  // Blosses "Monika" oder "Lukas" ohne Nachname ist dagegen zu unspezifisch für eine generelle
  // Prüfung (Gefahr von Zufallstreffern in völlig anderen Texten) — zählt daher nur als
  // Namenstreffer, wenn die Buchung bereits als "Mitglieder Sparkonto"-Übertrag erkannt ist
  // (isMitgliederSparkontoContext), wo der Verwendungszweck ohnehin schon als privat/haushalt-
  // intern feststeht und nur noch die Tag-Zuordnung fehlt.
  //
  // Regressions-Fix: generische Mitglieder-Sparkonto-Bezüge nennen oft GAR keinen Namen, nicht
  // mal "Monika"/"Lukas" (z.B. "Übertrag auf Mitglieder Sparkonto ... / Staatssteuern 2026 CHF
  // 1'700.00") — ohne Fallback konnte "Staatssteuern" (requiresName: "adult") dann nie mehr
  // greifen. Das gemeinsame Sparkonto wird faktisch von den Eltern verwaltet, nie von einem Kind
  // allein — daher gilt "Erwachsene" bei einem Mitglieder-Sparkonto-Übertrag als erfüllt, SOFERN
  // kein Kindername im Text steht (steht einer da, ist der Kontext eindeutig kinderbezogen, z.B.
  // "Ausbildungszulagen Lisa", und Kinder-Signalwörter sollen weiterhin nur dann greifen).
  function textHasAdultTransferName(lower, isMitgliederSparkontoContext) {
    if (NORMALIZED_ADULT_TRANSFER_NAMES.some((name) => lower.indexOf(name) !== -1)) return true;
    if (ADULT_SHORT_NAME_PATTERNS.some((pattern) => pattern.test(lower))) return true;
    if (isMitgliederSparkontoContext) {
      if (lower.indexOf("monika") !== -1 || lower.indexOf("lukas") !== -1) return true;
      if (!textHasChildName(lower)) return true;
    }
    return false;
  }
  function textHasChildName(lower) {
    return NORMALIZED_CHILD_NAMES.some((name) => lower.indexOf(name) !== -1);
  }
  function textHasAnyTransferPersonName(lower, isMitgliederSparkontoContext) {
    return textHasAdultTransferName(lower, isMitgliederSparkontoContext) || textHasChildName(lower);
  }

  function nameRequirementSatisfied(requiresName, lower, isMitgliederSparkontoContext) {
    if (requiresName === "adult") return textHasAdultTransferName(lower, isMitgliederSparkontoContext);
    if (requiresName === "child") return textHasChildName(lower);
    if (requiresName === "any") return textHasAnyTransferPersonName(lower, isMitgliederSparkontoContext);
    return true; // kein Eintrag = unbedingt gültig, kein Namensbezug nötig
  }

  // Tag-Ableitung ist rein informativ und beeinflusst nie die Kategorie. Erste zutreffende
  // Regel gewinnt (Reihenfolge der Liste = Priorität); ohne Treffer bleibt der Tag leer zur
  // manuellen Ergänzung statt eines geratenen Werts.
  //
  // requiresName pro Regel:
  //   "adult" — nur mit einem der drei Erwachsenen-Namensmuster (Monika Keller / Lukas Emanuel
  //             Keller / Lukas Emanuel und Monika Keller)
  //   "child" — nur mit einem der vier Kindernamen (Deborah/Eva/Lisa/Rebekka)
  //   "any"   — mit irgendeinem der sechs Namen (Erwachsene ODER Kinder) — z.B. "Rückerstattung"/
  //             "Rückzahlung"/"Beteiligung" sind personenunabhängig, nicht erwachsenen-exklusiv
  //   kein Eintrag — unbedingt, kein Namensbezug nötig (z.B. "Jugendlohn", Gesundheit-Wörter)
  //
  // requiresNameForCategory (optional, nur wo abweichend von requiresName): gilt ausschliesslich
  // für die KATEGORIE-Erkennung (hasMatchingTransferSignalWord(), aufgerufen von
  // containsPrivateTransferName()) und überschreibt requiresName dort. Grund: die Kategorie-Ebene
  // prüft Kindernamen strenger (nur "Name Keller"/"Keller Name", siehe
  // NORMALIZED_CHILD_TRANSFER_NAME_PATTERNS) als die Tag-Ableitung (bereits ein blosser
  // Vorname genügt, siehe textHasChildName/NORMALIZED_CHILD_NAMES) — bei "Geburi" führt das zu
  // unterschiedlichen Anforderungen: Auftraggeber ist oft die Eltern-Kombination ohne
  // wiederholten Kindernamen in derselben Zeile (z.B. "Lukas Emanuel und Monika Keller / 18.
  // Geburigeschenk"), die Tag-Ableitung soll aber weiterhin einen echten Kindernamen verlangen,
  // um z.B. "Geburifest Lukas" (eigener Geburtstag, kein Kinderbezug) nicht als "Kinder" zu taggen.
  const TAG_KEYWORD_RULES = [
    { tag: "Vorsorge", keywords: ["Säule 3a", "BVG", "PK-Einkauf", "Pensionskasse"], requiresName: "adult" },
    { tag: "Kinder", keywords: ["Jugendlohn"] },
    { tag: "Kinder", keywords: ["Ausbildungszulage", "Ausbildungskosten"], requiresName: "child" },
    // Für die Tag-Ableitung weiterhin an einen Kindernamen gekoppelt (unverändert), für die
    // Kategorie-Erkennung genügt irgendeiner der sechs Namen (requiresNameForCategory: "any").
    { tag: "Kinder", keywords: ["Geburi", "Geburigeschenk", "Geburifest"], requiresName: "child", requiresNameForCategory: "any" },
    { tag: "Rückstellungen", keywords: ["Selbstbehalt", "Reparatur"], requiresName: "any" },
    { tag: "Sparen", keywords: ["Sparen", "Reserve", "Rückstellung", "Ferien", "Amortisation", "Möbel", "Ungeplant", "Rückerstattung", "Rückzahlung", "Beteiligung"], requiresName: "any" },
    { tag: "Steuern", keywords: ["Steuern", "Staatssteuern"], requiresName: "adult" },
    { tag: "Gesundheit", keywords: ["Spitalkosten", "Spital", "Arzt", "Behandlung", "Operation"] },
    { tag: "Weiterbildung", keywords: ["ZHAW", "Weiterbildung", "Kurs"], requiresName: "adult" }
  ];

  // Manche Rohtexte enthalten durch Zeilenumbruch-Artefakte eingestreute Leerzeichen mitten im
  // Wort (z.B. "Amortis ation" statt "Amortisation", "Ungepla ntes" statt "Ungeplant") — ein
  // einfacher includes()-Vergleich verfehlt solche Schlüsselwörter dann. Der Regex-Abgleich
  // toleriert daher ZUSÄTZLICHEN Whitespace zwischen jedem Zeichen des Suchworts (inkl. eines im
  // Schlüsselwort bereits vorhandenen Leerzeichens, z.B. bei "Säule 3a"), verlangt aber weiterhin
  // mindestens die im Schlüsselwort selbst vorgesehenen Leerzeichen — ein komplett fehlendes
  // Leerzeichen (z.B. "Säule3a") zählt bewusst nicht als Treffer, das ist ein anderes Muster als
  // das beobachtete "zu viel Whitespace".
  const KEYWORD_MATCH_REGEX_CACHE = new Map();

  function escapeRegExpChar(ch) {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getKeywordMatchRegex(keywordLower) {
    let regex = KEYWORD_MATCH_REGEX_CACHE.get(keywordLower);
    if (!regex) {
      const pattern = keywordLower.split("").map(escapeRegExpChar).join("\\s*");
      regex = new RegExp(pattern);
      KEYWORD_MATCH_REGEX_CACHE.set(keywordLower, regex);
    }
    return regex;
  }

  function textMatchesKeyword(lowerText, keyword) {
    return getKeywordMatchRegex(keyword.toLowerCase()).test(lowerText);
  }

  function deriveKeywordTag(combinedText, isMitgliederSparkontoContext) {
    const lower = (combinedText || "").toLowerCase();
    for (const rule of TAG_KEYWORD_RULES) {
      if (!rule.keywords.some((kw) => textMatchesKeyword(lower, kw))) continue;
      if (!nameRequirementSatisfied(rule.requiresName, lower, isMitgliederSparkontoContext)) continue;
      return rule.tag;
    }
    return null;
  }

  // Gemeinsame Hilfsfunktion für Kategorie (containsPrivateTransferName) UND Tag-Ableitung
  // (deriveKeywordTag) — wiederverwendet TAG_KEYWORD_RULES als einzige Quelle der Wahrheit für
  // Signalwörter, damit beide Prüfungen nie auseinanderlaufen. Nur Regeln mit requiresName zählen
  // als "personenbezogenes Signalwort" in diesem Sinne (Jugendlohn/Gesundheit-Wörter ohne
  // requiresName sind hier nicht gemeint — Jugendlohn hat ohnehin einen eigenen Sonderfall davor,
  // siehe containsJugendlohnKeyword).
  function hasMatchingTransferSignalWord(lower, isAdultNameMatch, isChildNameMatch) {
    for (const rule of TAG_KEYWORD_RULES) {
      // requiresNameForCategory überschreibt requiresName nur für diese (Kategorie-)Prüfung,
      // siehe Kommentar bei TAG_KEYWORD_RULES (z.B. "Geburi": Tag bleibt an Kindername gekoppelt,
      // Kategorie genügt mit irgendeinem der sechs Namen).
      const requiresName = rule.requiresNameForCategory !== undefined ? rule.requiresNameForCategory : rule.requiresName;
      if (!requiresName) continue;
      if (requiresName === "adult" && !isAdultNameMatch) continue;
      if (requiresName === "child" && !isChildNameMatch) continue;
      // "any" ist an dieser Stelle immer zulässig, da der Aufrufer schon sichergestellt hat,
      // dass mindestens einer der beiden (isAdultNameMatch || isChildNameMatch) zutrifft.
      if (rule.keywords.some((kw) => textMatchesKeyword(lower, kw))) return true;
    }
    return false;
  }

  // Kernbereinigung (Datum, Uhrzeit, maskierte Kartennummer, Satzzeichen, Gross-/Kleinschreibung),
  // wiederverwendet sowohl für den Haupttext als auch für den Detailzeilen-Fallback unten.
  function normalizeMerchantKeyCore(rawText) {
    let s = (rawText || "").trim();

    s = s.replace(/^(Einkauf|Zahlung|Gutschrift|LSV|Dauerauftrag)\s+/i, "");

    s = s.replace(/\d{2}\.\d{2}\.\d{4}/g, " ");
    s = s.replace(/\d{1,2}:\d{2}/g, " ");
    s = s.replace(/\d+x+\d+/gi, " ");

    // Zahlungsmittel-Label, das nach Entfernen der Kartennummer übrig bleibt
    // (z.B. "Debit Mastercard-Nr." im Raiffeisen-Format).
    s = s.replace(/\b(Debit|Credit)\b/gi, " ");
    s = s.replace(/\b(Mastercard|Visa|Maestro)-?Nr\.?\b/gi, " ");
    s = s.replace(/\b(Mastercard|Visa|Maestro)\b/gi, " ");
    s = s.replace(/\bNr\.?\b/gi, " ");

    // Punkt in "Nr." wird wegen \b nicht mitgematcht und bleibt sonst als Streuzeichen übrig.
    // Satzzeichen werden zu Leerzeichen statt entfernt, damit z.B. "Coop-1983" zu "coop 1983"
    // wird — die Filialnummer bleibt Teil des Keys, nur der Trenner verschwindet.
    s = s.replace(/[-,;./]/g, " ");
    s = s.replace(/\s+/g, " ").trim();

    return s.toLowerCase();
  }

  // Rein generische Aktions-/Buchungsbegriffe ohne jede Empfänger-/Zweck-Information.
  // Kommt so ein Begriff nach der Kernbereinigung allein (oder nur zusammen mit einer
  // reinen Referenznummer) übrig, taugt der Haupttext nicht als Mapping-Key.
  const GENERIC_MAIN_TEXT_TERMS = ["dauerauftrag", "zahlung", "gutschrift", "überweisung", "lsv", "sammelzahlung"];

  function isGenericMainTextKey(mainKey) {
    const tokens = mainKey.split(" ").filter(Boolean);
    if (tokens.length === 0) return true;
    return tokens.every(t => GENERIC_MAIN_TEXT_TERMS.indexOf(t) !== -1 || /^\d+$/.test(t));
  }

  const DETAIL_FALLBACK_CHAR_LIMIT = 80;

  // Der Haupttext eines "Mitglieder Sparkonto"-Übertrags ist bei JEDEM Bezug vom selben
  // gemeinsamen Konto identisch (z.B. "Übertrag von Mitglieder Sparkonto CH46 ..."), unabhängig
  // vom tatsächlichen Verwendungszweck — er ist also genauso generisch wie "Dauerauftrag" oder
  // "Zahlung" und muss ebenfalls auf die Detailzeilen ausweichen, sonst wird ein für einen Bezug
  // gespeicherter Tag (z.B. "Vorsorge") fälschlich bei jedem späteren, andersartigen Bezug
  // vom selben Konto wiederverwendet.
  function isMitgliederSparkontoMainText(mainText) {
    return /Mitglieder\s+Sparkonto/i.test(mainText || "");
  }

  // Ein Haupttext, der nach dem Abstreifen des Aktionswort-Präfixes ("Zahlung"/"Gutschrift"/…)
  // NUR NOCH aus einem der sechs bekannten Namen besteht (z.B. "Zahlung Keller Rebekka" ->
  // "keller rebekka"), ist bei JEDER Buchung an/von dieser Person identisch — unabhängig vom
  // tatsächlichen Kauf/Zweck. Genauso generisch wie "Dauerauftrag"/"Sammelzahlung", muss also
  // ebenfalls auf die Detailzeile ausweichen. Bug-Fund: "Zahlung Keller Rebekka / Mehl CHF 1.90"
  // erbte sonst die Kategorie einer völlig anderen, früher gelernten "Zahlung Keller Rebekka"-
  // Buchung (z.B. einer Jugendlohn-Zeile), weil beide denselben reinen Namens-Key erzeugten.
  // Exakter Gleichheits-Vergleich (nicht "enthält"), da nur der REINE Name ohne jede
  // Zusatzinformation betroffen ist — "Keller Rebekka Coiffeur" bleibt ein eigener, gültiger Key.
  function isNameOnlyMainTextKey(mainKey) {
    return NORMALIZED_PRIVATE_TRANSFER_NAMES.indexOf(mainKey) !== -1;
  }

  // Liefert Key + Quelle ("text" oder "details"), damit z.B. das Mapping-Testen-Tool
  // nachvollziehbar machen kann, woraus der Key gebildet wurde.
  //
  // isSplitPart erzwingt den Details-Fallback UNBEDINGT, unabhängig davon, ob das Aktionswort im
  // (bei allen Sub-Transaktionen derselben Sammelzahlung/Dauerauftrag identischen) Haupttext
  // zufällig in GENERIC_MAIN_TEXT_TERMS steht: Bug-Fund — bei Haupttext "Sammelzahlung" (nicht in
  // der Wortliste, im Unterschied zu "Dauerauftrag") wurde der Key aus dem identischen Haupttext
  // gebildet statt aus der (bereits korrekt individuellen) Detailzeile, wodurch alle Sub-
  // Transaktionen denselben Key erzeugten und eine manuelle Korrektur einer Zeile fälschlich alle
  // anderen mittraf. Der Haupttext einer gesplitteten Sub-Transaktion ist PER DEFINITION nie
  // aussagekräftig (identisch über alle Geschwister-Zeilen hinweg) — die Wortlisten-Heuristik
  // darf hier keine Rolle spielen, es muss immer die individuelle Detailzeile sein.
  function computeMerchantKeyInfo(mainText, details, isSplitPart) {
    const mainKey = normalizeMerchantKeyCore(mainText);
    const useDetailsFallback = isSplitPart === true || isGenericMainTextKey(mainKey) ||
      isMitgliederSparkontoMainText(mainText) || isNameOnlyMainTextKey(mainKey);
    if (useDetailsFallback && details) {
      const detailSnippet = details.replace(/\n/g, " ").slice(0, DETAIL_FALLBACK_CHAR_LIMIT);
      const detailKey = normalizeMerchantKeyCore(detailSnippet);
      if (detailKey) {
        return { key: detailKey, source: "details" };
      }
    }
    return { key: mainKey, source: "text" };
  }

  // Damit derselbe Händler über mehrere Buchungen hinweg denselben Mapping-Key ergibt —
  // bei generischen Haupttexten ("Dauerauftrag", "Zahlung", …) oder gesplitteten Sub-
  // Transaktionen wird auf die Detailzeilen ausgewichen, sofern vorhanden (siehe
  // computeMerchantKeyInfo).
  function normalizeMerchantKey(mainText, details, isSplitPart) {
    return computeMerchantKeyInfo(mainText, details, isSplitPart).key;
  }

  // Leitet Transfer-Badge/-Richtung direkt aus der zugewiesenen Kategorie ab (statt aus der
  // Text-Erkennung), damit ein gelerntes Mapping auf eine Transfer-Kategorie dieselbe
  // Darstellung bekommt wie ein über Text-Pattern erkannter Transfer.
  function deriveTransferInfoFromCategory(category) {
    if (category === "Transfer: Haushalt → Sparkonto") return { isTransfer: true, transferDirection: "auf Sparkonto" };
    if (category === "Transfer: Sparkonto → Haushalt") return { isTransfer: true, transferDirection: "von Sparkonto" };
    return { isTransfer: false, transferDirection: null };
  }

  // Zentrale Vorzeichen-Regel, verbindlich für JEDE Zuweisung einer Transfer-Kategorie —
  // egal ob der Vorschlag aus Text-Pattern-Erkennung, gelerntem Mapping, Claude oder manueller
  // Dropdown-Auswahl kommt: "Haushalt → Sparkonto" ist immer negativ, "Sparkonto → Haushalt"
  // immer positiv. Nicht-Transfer-Kategorien und ein fehlender Betrag sind immer gültig
  // (Vorzeichen lässt sich dann nicht prüfen).
  function validateTransferSign(category, amount) {
    if (TRANSFER_CATEGORIES.indexOf(category) === -1 || amount === null) {
      return { valid: true };
    }
    const mismatch = (category === "Transfer: Haushalt → Sparkonto" && amount >= 0) ||
      (category === "Transfer: Sparkonto → Haushalt" && amount < 0);
    return { valid: !mismatch };
  }

  // Gate für AUTOMATISCHE Zuweisungen (Text-Pattern, gelerntes Mapping, Claude): bei
  // Vorzeichen-Konflikt wird NICHT zugewiesen (category bleibt null), needsManualReview
  // markiert die Zeile stattdessen zur manuellen Prüfung. Manuelle Dropdown-Auswahl geht
  // NICHT über dieses Gate (siehe buildCategoryCell in index.html) — dort ist Übersteuern erlaubt.
  function resolveCategoryAssignment(category, amount) {
    if (category === null) return { category: null, needsManualReview: false, signMismatchSuggested: null };
    const validation = validateTransferSign(category, amount);
    if (validation.valid) return { category: category, needsManualReview: false, signMismatchSuggested: null };
    return { category: null, needsManualReview: true, signMismatchSuggested: category };
  }

  function detectTransfer(mainText, details, amount) {
    const combined = (mainText + " " + details);
    if (!combined.includes("Mitglieder Sparkonto")) {
      return { isTransfer: false, direction: null, category: null, signMismatch: false, suggestedCategory: null };
    }

    let direction;
    let candidateCategory;
    if (/Übertrag\s+von/i.test(combined)) {
      direction = "von Sparkonto";
      candidateCategory = "Transfer: Sparkonto → Haushalt";
    } else if (/Übertrag\s+auf/i.test(combined)) {
      direction = "auf Sparkonto";
      candidateCategory = "Transfer: Haushalt → Sparkonto";
    } else {
      // Richtung nicht aus dem Text erkennbar — anhand des Vorzeichens ableiten
      // (Geld weg vom Haushaltskonto = Haushalt → Sparkonto, Geld zurück = Sparkonto → Haushalt).
      // Dieser Zweig kann per Definition nie einen Vorzeichen-Konflikt erzeugen.
      direction = null;
      candidateCategory = (amount !== null && amount < 0) ? "Transfer: Haushalt → Sparkonto" : "Transfer: Sparkonto → Haushalt";
    }

    const resolved = resolveCategoryAssignment(candidateCategory, amount);

    return {
      isTransfer: true,
      direction: direction,
      category: resolved.category,
      signMismatch: resolved.needsManualReview,
      suggestedCategory: resolved.signMismatchSuggested
    };
  }

  function detectVorsorgeCategory(mainText, details) {
    const combined = mainText + " " + details;
    if (/Säule\s*3a/i.test(combined)) return "Vorsorge & Anlagen";
    // "BVG"/"Pensionskasse" allein sind zu generisch (z.B. normale Lohnabzüge) — erst in
    // Kombination mit "Einkauf" eindeutig ein freiwilliger Vorsorge-Einkauf.
    if (/\bBVG\b/i.test(combined) && /Einkauf/i.test(combined)) return "Vorsorge & Anlagen";
    if (/Pensionskasse/i.test(combined) && /Einkauf/i.test(combined)) return "Vorsorge & Anlagen";
    if (/Interactive\s*Brokers/i.test(combined)) return "Vorsorge & Anlagen";
    return null;
  }

  function detectKreditkartenSammelbuchungCategory(mainText, details) {
    if (/Viseca/i.test(mainText)) return "Kreditkarte (Sammelbuchung)";
    const hasCardKeyword = /Kartenkonto/i.test(details) || /Card Payment/i.test(details);
    if (hasCardKeyword && /LSV/i.test(mainText)) return "Kreditkarte (Sammelbuchung)";
    return null;
  }

  // Bündelt alle textbasierten Auto-Kategorisierungen (Sparkonto-Transfer, Kreditkarten-
  // Sammelbuchung, Vorsorge), die ohne Claude-API direkt beim Parsen zugeordnet werden.
  function detectAutoCategory(mainText, details, amount) {
    const transferInfo = detectTransfer(mainText, details, amount);
    if (transferInfo.isTransfer) {
      return {
        isTransfer: true,
        transferDirection: transferInfo.direction,
        category: transferInfo.category,
        categorySource: transferInfo.signMismatch ? null : "transfer",
        signMismatch: transferInfo.signMismatch,
        suggestedCategory: transferInfo.suggestedCategory
      };
    }
    const sammelbuchungCategory = detectKreditkartenSammelbuchungCategory(mainText, details);
    if (sammelbuchungCategory) {
      return { isTransfer: false, transferDirection: null, category: sammelbuchungCategory, categorySource: "auto" };
    }
    const vorsorgeCategory = detectVorsorgeCategory(mainText, details);
    if (vorsorgeCategory) {
      return { isTransfer: false, transferDirection: null, category: vorsorgeCategory, categorySource: "auto" };
    }
    return { isTransfer: false, transferDirection: null, category: null, categorySource: null };
  }

  // Für das Aufräumen gelernter Mappings (Settings-Modal): ein gespeicherter Mapping-Key ist
  // bereits die normalisierte (kleingeschriebene) Fassung des Originaltexts — ein Namens- (inkl.
  // der vier Kindernamen, da NORMALIZED_PRIVATE_TRANSFER_NAMES diese bereits enthält) oder
  // "Interactive Brokers"-Treffer lässt sich daher direkt am Key selbst prüfen, ohne den
  // ursprünglichen Rohtext erneut vorzuhalten.
  //
  // Bei mehreren unscharfen Treffern gewinnt der längste gespeicherte Key (spezifischster Match).
  // Kürzere Keys (z.B. "sbb", "zh", "coop") sind als Substring in fast allem enthalten
  // und würden reihenweise falsche Kategorien zuweisen — daher nur Fallback-Match,
  // wenn der kürzere der beiden verglichenen Keys diese Mindestlänge erreicht.
  const FUZZY_MATCH_MIN_LENGTH = 6;

  // Transfer-Kategorien dürfen NIE aus einem gelernten Mapping kommen — auch nicht aus
  // Alt-Einträgen, die vor dieser Regel gespeichert wurden (stale Mappings). Solche Einträge
  // werden hier komplett ignoriert (weder als exakter noch als unscharfer Treffer), damit z.B.
  // ein alter Eintrag "monika keller" -> "Transfer: Haushalt → Sparkonto" nicht versehentlich
  // eine völlig andere, künftige "Gutschrift Monika Keller"-Buchung falsch zuordnet.
  //
  // learnedCategories wird als Parameter übergeben (statt aus einer Closure gelesen), damit diese
  // Funktion ohne den localStorage-gestützten App-State testbar bleibt.
  function findLearnedCategoryMatch(key, learnedCategories) {
    if (!key || !learnedCategories) return null;
    if (Object.prototype.hasOwnProperty.call(learnedCategories, key)) {
      const exactCategory = learnedCategories[key];
      if (TRANSFER_CATEGORIES.indexOf(exactCategory) === -1) {
        return { category: exactCategory, matchedKey: key, matchType: "exact" };
      }
    }
    let best = null;
    for (const storedKey of Object.keys(learnedCategories)) {
      if (!storedKey) continue;
      const storedCategory = learnedCategories[storedKey];
      if (TRANSFER_CATEGORIES.indexOf(storedCategory) !== -1) continue;
      if (Math.min(key.length, storedKey.length) < FUZZY_MATCH_MIN_LENGTH) continue;
      if (key.indexOf(storedKey) !== -1 || storedKey.indexOf(key) !== -1) {
        if (!best || storedKey.length > best.matchedKey.length) {
          best = { category: storedCategory, matchedKey: storedKey, matchType: "fuzzy" };
        }
      }
    }
    return best;
  }

  // Diagnose für riskante Fuzzy-Match-Kollisionen: ein kurzer, generischer alter Key (z.B.
  // "stadt zürich" aus einer früheren, andersartigen Buchung) kann als Substring fälschlich
  // gegen eine neue, eigentlich unabhängige Buchung matchen (z.B. "Stadt Zürich
  // Schulgesundheitsdienste" fälschlich als "Mobilität", analog zum früheren Interactive-
  // Brokers/Abos-Fall). Nur unscharfe (nicht exakte) Treffer haben dieses Risiko. Der geloggte
  // "gefundenerGespeicherterKey" lässt sich direkt im Settings-Modal unter "Gelernte Zuordnungen"
  // suchen und bei Bedarf löschen — diese Diagnose kann den Eintrag nicht selbst entfernen, da
  // sie nur zur Laufzeit im Browser des Nutzers sichtbar ist.
  function logFuzzyMappingMatch(mainText, details, key, learnedMatch) {
    if (!learnedMatch || learnedMatch.matchType !== "fuzzy") return;
    console.log("[Fuzzy-Mapping-Diagnose] Unscharfer Treffer angewendet:", {
      text: mainText,
      details: details,
      berechneterKey: key,
      gefundenerGespeicherterKey: learnedMatch.matchedKey,
      zugewieseneKategorie: learnedMatch.category
    });
  }

  // Priorität bei jeder Kategoriezuweisung, in dieser Reihenfolge (höher blockiert niedriger
  // AUSNAHMSLOS — insbesondere darf Stufe 5 (gelerntes Mapping) NIE Stufe 2-4 überschreiben,
  // auch nicht durch einen alten, inzwischen falschen Lern-Eintrag):
  // 1. Manuelle Korrektur (Dropdown, Quelle "manual")               — greift nicht hier, sondern
  //    dadurch, dass categorizeTransactions() nur category === null neu anfasst.
  // 2. Namensregel für private Sparkonto-Transfers (containsPrivateTransferName), mit
  //    Jugendlohn-Ausnahme (containsJugendlohnKeyword) davor
  // 3. "Mitglieder Sparkonto"-Texterkennung (detectTransfer)
  // 4. Andere automatische Texterkennung (Interactive Brokers, Viseca/Kreditkarte, Säule 3a, …)
  // 5. Gelerntes Mapping, exakter oder unscharfer Treffer
  // 6. Claude-API (nur was hier null bleibt, wird später in categorizeTransactions() versucht)
  //
  // learnedCategories wird als Parameter übergeben (statt aus einer Closure gelesen), damit diese
  // Funktion ohne den localStorage-gestützten App-State testbar bleibt.
  function resolveInitialCategorization(mainText, details, amount, isSplitPart, learnedCategories) {
    // Jugendlohn-Ausnahme: läuft VOR der Namensregel und blockiert sie, auch wenn ein Kind-/
    // Elternname im selben Text vorkommt — Jugendlohn ist eine reguläre Ausgabe, keine
    // Sparbewegung. Ausnahmslos, auch für Dauerauftrag-Splits, aus denselben Gründen wie die
    // Namensregel selbst (siehe unten).
    if (containsJugendlohnKeyword(mainText, details)) {
      return {
        isTransfer: false,
        transferDirection: null,
        category: "Kinder",
        categorySource: "jugendlohn-kinder",
        learnedMatchedKey: null,
        needsManualReview: false,
        signMismatchSuggested: null,
        allowTagDerivation: true
      };
    }

    // Stufe 2 läuft ausnahmslos, auch für Dauerauftrag-Splits: jeder Split-Teil hat bereits
    // seine eigene, spezifische Detailzeile (nicht den generischen, geteilten Haupttext) — der
    // Name lässt sich darin zuverlässig prüfen, siehe containsPrivateTransferName().
    if (containsPrivateTransferName(mainText, details)) {
      const privateCategory = resolvePrivateTransferCategory(amount);
      if (privateCategory) {
        const transferInfo = deriveTransferInfoFromCategory(privateCategory);
        return {
          isTransfer: transferInfo.isTransfer,
          transferDirection: transferInfo.transferDirection,
          category: privateCategory,
          categorySource: "name-transfer",
          learnedMatchedKey: null,
          needsManualReview: false,
          signMismatchSuggested: null,
          allowTagDerivation: true
        };
      }
    }

    // Bei aufgesplitteten Sub-Transaktionen hat der gemeinsame Haupttext keine Aussagekraft für
    // die übrige automatische Texterkennung (z.B. Miete + Spende in einem Dauerauftrag) — diese
    // bleiben (ausser bei obigen Ausnahmen) bewusst unkategorisiert für gelerntes Mapping /
    // Claude in Stufe 5/6.
    if (isSplitPart) {
      return { isTransfer: false, transferDirection: null, category: null, categorySource: null, learnedMatchedKey: null, needsManualReview: false, signMismatchSuggested: null, allowTagDerivation: false };
    }

    // Stufe 3+4, VOR dem gelernten Mapping (siehe Prioritäts-Kommentar oben) — damit ein alter,
    // falscher Lern-Eintrag (z.B. Interactive Brokers fälschlich als "Abos" gelernt) diese
    // Texterkennung nie mehr überschreiben kann.
    const auto = detectAutoCategory(mainText, details, amount);
    if (auto.category !== null || auto.signMismatch === true) {
      return {
        isTransfer: auto.isTransfer,
        transferDirection: auto.transferDirection,
        category: auto.category,
        categorySource: auto.categorySource,
        learnedMatchedKey: null,
        needsManualReview: auto.signMismatch === true,
        signMismatchSuggested: auto.suggestedCategory || null,
        // Auch bei der Mitglieder-Sparkonto-Erkennung (auto.isTransfer) soll die Schlüsselwort-
        // Tag-Ableitung greifen können (z.B. "Gesundheit" bei "Für Spitalkosten CHF 2'000.00"),
        // nicht nur bei der Namensregel — bei "auto" (Sammelbuchung/Vorsorge) ergibt ein
        // Transfer-Tag hingegen keinen Sinn.
        allowTagDerivation: auto.isTransfer
      };
    }

    // Stufe 5: gelerntes Mapping — kommt erst jetzt zum Zug, wenn Stufe 2-4 nichts gefunden haben.
    const key = normalizeMerchantKey(mainText, details);
    const learnedMatch = findLearnedCategoryMatch(key, learnedCategories);
    logFuzzyMappingMatch(mainText, details, key, learnedMatch);
    // findLearnedCategoryMatch() liefert Transfer-Kategorien grundsätzlich nie mehr zurück —
    // die Vorzeichen-Prüfung hier ist zusätzliche Absicherung über die zentrale Gate-Funktion,
    // damit diese Garantie nicht an einer einzelnen Stelle im Code hängt.
    if (learnedMatch && ALL_CATEGORY_OPTIONS.indexOf(learnedMatch.category) !== -1 &&
        validateTransferSign(learnedMatch.category, amount).valid) {
      const transferInfo = deriveTransferInfoFromCategory(learnedMatch.category);
      return {
        isTransfer: transferInfo.isTransfer,
        transferDirection: transferInfo.transferDirection,
        category: learnedMatch.category,
        categorySource: learnedMatch.matchType === "exact" ? "learned" : "learned-fuzzy",
        learnedMatchedKey: learnedMatch.matchedKey,
        needsManualReview: false,
        signMismatchSuggested: null,
        allowTagDerivation: false
      };
    }

    // Stufe 6: nichts automatisch gefunden — bleibt offen für Claude (categorizeTransactions()).
    return { isTransfer: false, transferDirection: null, category: null, categorySource: null, learnedMatchedKey: null, needsManualReview: false, signMismatchSuggested: null, allowTagDerivation: false };
  }

  // savedTags wird als Parameter übergeben (statt aus einer Closure gelesen), damit diese
  // Funktion ohne den localStorage-gestützten App-State testbar bleibt.
  function lookupSavedTag(mainText, details, isSplitPart, savedTags) {
    const key = normalizeMerchantKey(mainText, details, isSplitPart);
    if (!key || !savedTags) return null;
    return Object.prototype.hasOwnProperty.call(savedTags, key) ? savedTags[key] : null;
  }

  // Einziger erlaubter Weg, ein neu geparstes Transaktionsobjekt mit einem Tag zu versehen:
  // ein gespeicherter (= vom Nutzer irgendwann manuell gesetzter) Tag hat IMMER Vorrang und wird
  // NIE durch eine automatische Ableitung überschrieben — auch nicht bei erneutem CSV-Import mit
  // ähnlichem Text oder erneutem Klick auf "Kategorisieren". Die automatische Schlüsselwort-
  // Ableitung (deriveKeywordTag()) kommt ausschliesslich zum Zug, wenn noch KEIN gespeicherter
  // Tag existiert UND es sich um einen erkannten Transfer handelt (Namensregel ODER Mitglieder-
  // Sparkonto) — nur dort ergeben "Vorsorge"/"Kinder"/"Gesundheit"/etc. als Tag Sinn.
  function resolveInitialTag(mainText, details, allowTagDerivation, isSplitPart, savedTags) {
    const savedTag = lookupSavedTag(mainText, details, isSplitPart, savedTags);
    if (savedTag) return savedTag;
    if (!allowTagDerivation) return null;
    return deriveKeywordTag(mainText + " " + details, isMitgliederSparkontoMainText(mainText));
  }

  return {
    CATEGORIES,
    TRANSFER_CATEGORIES,
    ALL_CATEGORY_OPTIONS,
    NORMALIZED_PRIVATE_TRANSFER_NAMES,
    containsPrivateTransferName,
    hasMatchingTransferSignalWord,
    deriveKeywordTag,
    normalizeMerchantKey,
    computeMerchantKeyInfo,
    resolveInitialCategorization,
    resolveInitialTag,
    validateTransferSign,
    detectAutoCategory,
    findLearnedCategoryMatch,
    deriveTransferInfoFromCategory,
    resolveCategoryAssignment,
    logFuzzyMappingMatch
  };
});
