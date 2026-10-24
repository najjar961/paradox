# Lecture 3: Describing data

## Measures of central tendency
The **mean** is the sum of all values divided by how many there are: \( \bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i \).
The **median** is the middle value once the data are sorted. With an even number of values, it is the mean of the two middle values. The median is robust: a single extreme value (an outlier) barely moves it, while it can shift the mean a lot.
The **mode** is the value that occurs most often.

## Measures of spread
The **range** is the largest value minus the smallest.
The **variance** measures how far the values lie from the mean on average: \( \sigma^2 = \frac{1}{n}\sum_{i=1}^{n} (x_i - \bar{x})^2 \). For a sample, divide by \( n-1 \) instead of \( n \).
The **standard deviation** \( \sigma \) is the square root of the variance. It has the same unit as the data, which makes it easier to interpret.

## Worked example
Five students scored 4, 7, 7, 8 and 9 points.
- Mean: \( (4+7+7+8+9)/5 = 35/5 = 7 \)
- Median: 7 (the third of five sorted values)
- Mode: 7
- Range: \( 9 - 4 = 5 \)
- Variance: the squared deviations are 9, 0, 0, 1 and 4, so \( \sigma^2 = 14/5 = 2.8 \) and \( \sigma \approx 1.67 \)

## Key point for the exam
Report the median instead of the mean when the data contain outliers or are skewed, for example incomes.
