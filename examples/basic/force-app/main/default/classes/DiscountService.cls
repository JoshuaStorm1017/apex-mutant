public with sharing class DiscountService {
    public static Decimal price(Decimal subtotal, Boolean member) {
        if (subtotal < 0) {
            throw new IllegalArgumentException('Subtotal must not be negative');
        }
        if (member && subtotal >= 100) {
            return subtotal * 0.9;
        }
        return subtotal;
    }

    public static Boolean eligible(Integer points) {
        return points >= 100;
    }
}
