//! Numbers, said the way a reader reads them aloud.
//!
//! Measured over 5 M words of real books, numbers are **3.3 % of every token** —
//! the second largest gap after inflected words, and the one sherpa-onnx also
//! handed to espeak-ng. A reader meets years far more often than quantities, so
//! `1980` is *nineteen eighty* rather than *one thousand nine hundred eighty*,
//! and `1980s` is *nineteen eighties*.
//!
//! American usage throughout, matching the voices: no *and* before the tens.

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const SCALES: [(u64, &str); 5] = [
    (1_000_000_000_000, "trillion"),
    (1_000_000_000, "billion"),
    (1_000_000, "million"),
    (1_000, "thousand"),
    (100, "hundred"),
];
/// The ordinal forms that are not simply the cardinal plus `-th`.
const ORDINALS: [(&str, &str); 12] = [
    ("one", "first"),
    ("two", "second"),
    ("three", "third"),
    ("five", "fifth"),
    ("eight", "eighth"),
    ("nine", "ninth"),
    ("twelve", "twelfth"),
    ("twenty", "twentieth"),
    ("thirty", "thirtieth"),
    ("forty", "fortieth"),
    ("fifty", "fiftieth"),
    ("ninety", "ninetieth"),
];

/// A whole number in words: `128` is *one hundred twenty-eight*.
#[must_use]
pub fn cardinal(value: u64) -> String {
    if value < 20 {
        return ONES[value as usize].to_owned();
    }
    if value < 100 {
        let (tens, ones) = (value / 10, value % 10);
        return if ones == 0 {
            TENS[tens as usize].to_owned()
        } else {
            format!("{} {}", TENS[tens as usize], ONES[ones as usize])
        };
    }
    for (scale, name) in SCALES {
        if value >= scale {
            let (count, rest) = (value / scale, value % scale);
            let head = format!("{} {name}", cardinal(count));
            return if rest == 0 { head } else { format!("{head} {}", cardinal(rest)) };
        }
    }
    ONES[0].to_owned()
}

/// `2nd` is *second*, `21st` is *twenty-first*.
#[must_use]
pub fn ordinal(value: u64) -> String {
    let words = cardinal(value);
    let (head, last) = match words.rsplit_once(' ') {
        Some((head, last)) => (Some(head), last),
        None => (None, words.as_str()),
    };
    let last = ORDINALS
        .iter()
        .find_map(|(cardinal, ordinal)| (*cardinal == last).then(|| (*ordinal).to_owned()))
        .unwrap_or_else(|| {
            // The regular forms: `-th`, with `-y` becoming `-ieth`.
            last.strip_suffix('y').map_or_else(|| format!("{last}th"), |stem| format!("{stem}ieth"))
        });
    match head {
        Some(head) => format!("{head} {last}"),
        None => last,
    }
}

/// A year: `1980` is *nineteen eighty*, `2005` is *two thousand five*, `1900` is
/// *nineteen hundred*.
///
/// Only four-digit numbers in a range a book's dates fall in are read this way —
/// `1066` yes, `3500` no, because *thirty-five hundred* is a quantity.
#[must_use]
pub fn year(value: u64) -> String {
    let (high, low) = (value / 100, value % 100);
    // 1000–2099: the years a book cites. `3500` is a quantity, not a year.
    if !(10..=20).contains(&high) {
        return cardinal(value);
    }
    // 2000–2009 are said in full: *two thousand five*, never *twenty oh five*.
    if high == 20 && low < 10 {
        return cardinal(value);
    }
    if low == 0 {
        return format!("{} hundred", cardinal(high));
    }
    if low < 10 {
        return format!("{} oh {}", cardinal(high), cardinal(low));
    }
    format!("{} {}", cardinal(high), cardinal(low))
}

/// A decade: `1980s` is *nineteen eighties*, `1900s` is *nineteen hundreds*.
#[must_use]
pub fn decade(value: u64) -> String {
    let words = year(value);
    let (head, last) = match words.rsplit_once(' ') {
        Some((head, last)) => (head.to_owned(), last.to_owned()),
        None => (String::new(), words.clone()),
    };
    let plural = match last.as_str() {
        "hundred" => "hundreds".to_owned(),
        other if other.ends_with('y') => format!("{}ies", &other[..other.len() - 1]),
        other if other.ends_with('x') || other.ends_with('s') => format!("{other}es"),
        other => format!("{other}s"),
    };
    if head.is_empty() {
        plural
    } else {
        format!("{head} {plural}")
    }
}

/// The digits after a decimal point, read one by one: `3.14` is *three point one
/// four*, which is how a reader says it and `three point fourteen` is not.
#[must_use]
pub fn decimal(whole: u64, fraction: &str) -> String {
    let digits: Vec<&str> = fraction
        .chars()
        .filter(char::is_ascii_digit)
        .map(|c| ONES[c.to_digit(10).unwrap_or(0) as usize])
        .collect();
    format!("{} point {}", cardinal(whole), digits.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_numbers_read_as_a_person_says_them() {
        assert_eq!(cardinal(0), "zero");
        assert_eq!(cardinal(7), "seven");
        assert_eq!(cardinal(13), "thirteen");
        assert_eq!(cardinal(20), "twenty");
        assert_eq!(cardinal(21), "twenty one");
        assert_eq!(cardinal(100), "one hundred");
        assert_eq!(cardinal(128), "one hundred twenty eight");
        assert_eq!(cardinal(1_000), "one thousand");
        assert_eq!(cardinal(1_234), "one thousand two hundred thirty four");
        assert_eq!(cardinal(1_000_000), "one million");
        assert_eq!(cardinal(2_500_000), "two million five hundred thousand");
    }

    #[test]
    fn ordinals_keep_their_irregular_forms() {
        assert_eq!(ordinal(1), "first");
        assert_eq!(ordinal(2), "second");
        assert_eq!(ordinal(3), "third");
        assert_eq!(ordinal(4), "fourth");
        assert_eq!(ordinal(5), "fifth");
        assert_eq!(ordinal(12), "twelfth");
        assert_eq!(ordinal(20), "twentieth");
        assert_eq!(ordinal(21), "twenty first");
        assert_eq!(ordinal(30), "thirtieth");
        assert_eq!(ordinal(100), "one hundredth");
    }

    #[test]
    fn years_are_read_as_years_and_not_as_quantities() {
        assert_eq!(year(1980), "nineteen eighty");
        assert_eq!(year(1066), "ten sixty six");
        assert_eq!(year(1900), "nineteen hundred");
        assert_eq!(year(1905), "nineteen oh five");
        assert_eq!(year(2026), "twenty twenty six");
        assert_eq!(year(2000), "two thousand", "not `twenty hundred`");
        assert_eq!(year(2005), "two thousand five", "not `twenty oh five`");
        assert_eq!(
            year(3500),
            cardinal(3500),
            "a number outside the years a book cites is a quantity"
        );
    }

    #[test]
    fn decades_are_plural_years() {
        assert_eq!(decade(1980), "nineteen eighties");
        assert_eq!(decade(1900), "nineteen hundreds");
        assert_eq!(decade(2020), "twenty twenties");
        assert_eq!(decade(1960), "nineteen sixties");
    }

    #[test]
    fn a_decimal_is_read_digit_by_digit_after_the_point() {
        assert_eq!(decimal(3, "14"), "three point one four");
        assert_eq!(decimal(0, "5"), "zero point five");
        assert_eq!(decimal(20, "05"), "twenty point zero five");
    }
}
