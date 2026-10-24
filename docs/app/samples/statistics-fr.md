# Cours 3 : Décrire des données

## Mesures de tendance centrale
La **moyenne** est la somme de toutes les valeurs divisée par leur nombre : \( \bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i \).
La **médiane** est la valeur du milieu une fois les données triées. Avec un nombre pair de valeurs, c'est la moyenne des deux valeurs du milieu. La médiane est robuste : une seule valeur extrême (une valeur aberrante) la déplace à peine, alors qu'elle peut beaucoup modifier la moyenne.
Le **mode** est la valeur la plus fréquente.

## Mesures de dispersion
L'**étendue** est la plus grande valeur moins la plus petite.
La **variance** mesure à quelle distance les valeurs se trouvent en moyenne de la moyenne : \( \sigma^2 = \frac{1}{n}\sum_{i=1}^{n} (x_i - \bar{x})^2 \). Pour un échantillon, on divise par \( n-1 \) au lieu de \( n \).
L'**écart type** \( \sigma \) est la racine carrée de la variance. Il a la même unité que les données, ce qui le rend plus facile à interpréter.

## Exemple corrigé
Cinq étudiants ont obtenu 4, 7, 7, 8 et 9 points.
- Moyenne : \( (4+7+7+8+9)/5 = 35/5 = 7 \)
- Médiane : 7 (la troisième des cinq valeurs triées)
- Mode : 7
- Étendue : \( 9 - 4 = 5 \)
- Variance : les écarts au carré sont 9, 0, 0, 1 et 4, donc \( \sigma^2 = 14/5 = 2{,}8 \) et \( \sigma \approx 1{,}67 \)

## À retenir pour l'examen
Donnez la médiane plutôt que la moyenne lorsque les données contiennent des valeurs aberrantes ou sont asymétriques, par exemple les revenus.
