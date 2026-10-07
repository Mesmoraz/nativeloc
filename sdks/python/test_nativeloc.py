"""Run with: python -m unittest sdks/python/test_nativeloc.py"""
import unittest

from nativeloc import format_message, plural_category


class FormatTests(unittest.TestCase):
    def test_args_and_escapes(self):
        self.assertEqual(format_message("Hello {name}!", {"name": "Ana"}), "Hello Ana!")
        self.assertEqual(format_message("Don't '{'touch'}'", {}), "Don't {touch}")

    def test_plurals(self):
        msg = "{n, plural, =0 {Sold out} one {# item} other {# items}}"
        self.assertEqual(format_message(msg, {"n": 0}), "Sold out")
        self.assertEqual(format_message(msg, {"n": 1}), "1 item")
        self.assertEqual(format_message(msg, {"n": 7}), "7 items")
        ru = "{n, plural, one {# товар} few {# товара} many {# товаров} other {# товара}}"
        self.assertEqual(format_message(ru, {"n": 3}, "ru"), "3 товара")
        self.assertEqual(format_message(ru, {"n": 11}, "ru"), "11 товаров")
        self.assertEqual(format_message(ru, {"n": 21}, "ru"), "21 товар")

    def test_select(self):
        msg = "{g, select, female {She} male {He} other {They}} paid"
        self.assertEqual(format_message(msg, {"g": "female"}), "She paid")
        self.assertEqual(format_message(msg, {"g": "x"}), "They paid")

    def test_bad_message_is_returned_raw(self):
        self.assertEqual(format_message("Hi {name", {}), "Hi {name")

    def test_categories(self):
        self.assertEqual(plural_category("fr", 0), "one")
        self.assertEqual(plural_category("pl", 22), "few")
        self.assertEqual(plural_category("ar", 11), "many")
        self.assertEqual(plural_category("ja", 1), "other")

    def test_filipino_categories_match_cldr(self):
        # CLDR fil/tl: "other" only for integers ending in 4, 6 or 9 (and fractions likewise)
        for n in (0, 1, 2, 3, 5, 7, 8, 10, 11, 12, 15, 101, 1000):
            self.assertEqual(plural_category("tl", n), "one", n)
        for n in (4, 6, 9, 14, 16, 19, 24, 106):
            self.assertEqual(plural_category("fil", n), "other", n)
        self.assertEqual(plural_category("fil-PH", 2.5), "one")
        self.assertEqual(plural_category("tl", 2.4), "other")


if __name__ == "__main__":
    unittest.main()
