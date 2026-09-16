@IsTest
private class DiscountServiceTest {
    @IsTest static void discountsMembers() {
        System.assertEquals(90, DiscountService.price(100, true));
        System.assertEquals(100, DiscountService.price(100, false));
        System.assertEquals(50, DiscountService.price(50, true));
    }

    @IsTest static void checksEligibility() {
        // Deliberately misses the boundary at exactly 100.
        // Add assertEquals(true, DiscountService.eligible(100)) to kill that mutant.
        System.assertEquals(false, DiscountService.eligible(99));
        System.assertEquals(true, DiscountService.eligible(101));
    }

    @IsTest static void rejectsNegativeSubtotal() {
        try {
            DiscountService.price(-1, false);
            System.assert(false, 'Expected a validation error');
        } catch (IllegalArgumentException expected) {
            System.assertEquals('Subtotal must not be negative', expected.getMessage());
        }
    }
}
