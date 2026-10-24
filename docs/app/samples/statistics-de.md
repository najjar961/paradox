# Vorlesung 3: Daten beschreiben

## Lagemaße
Der **Mittelwert** ist die Summe aller Werte geteilt durch ihre Anzahl: \( \bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i \).
Der **Median** ist der mittlere Wert der sortierten Daten. Bei einer geraden Anzahl von Werten ist er der Mittelwert der beiden mittleren Werte. Der Median ist robust: Ein einzelner Extremwert (Ausreißer) verschiebt ihn kaum, den Mittelwert dagegen oft stark.
Der **Modus** ist der Wert, der am häufigsten vorkommt.

## Streuungsmaße
Die **Spannweite** ist der größte Wert minus der kleinste.
Die **Varianz** misst, wie weit die Werte im Durchschnitt vom Mittelwert entfernt liegen: \( \sigma^2 = \frac{1}{n}\sum_{i=1}^{n} (x_i - \bar{x})^2 \). Bei einer Stichprobe teilt man durch \( n-1 \) statt durch \( n \).
Die **Standardabweichung** \( \sigma \) ist die Wurzel aus der Varianz. Sie hat dieselbe Einheit wie die Daten und ist deshalb leichter zu deuten.

## Rechenbeispiel
Fünf Studierende erreichten 4, 7, 7, 8 und 9 Punkte.
- Mittelwert: \( (4+7+7+8+9)/5 = 35/5 = 7 \)
- Median: 7 (der dritte von fünf sortierten Werten)
- Modus: 7
- Spannweite: \( 9 - 4 = 5 \)
- Varianz: Die quadrierten Abweichungen sind 9, 0, 0, 1 und 4, also \( \sigma^2 = 14/5 = 2{,}8 \) und \( \sigma \approx 1{,}67 \)

## Wichtig für die Klausur
Geben Sie den Median statt des Mittelwerts an, wenn die Daten Ausreißer enthalten oder schief verteilt sind, zum Beispiel bei Einkommen.
