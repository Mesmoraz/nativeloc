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


if __name__ == "__main__":
    unittest.main()
