<?php
// Read-only arithmetic oracle. Invoke the actual PHP source method, without
// framework boot, constructor, application settings, database or network I/O.
namespace app\services {
    class BaseServices {
        public function __call($name, $arguments) {
            throw new \RuntimeException('Unexpected framework call: ' . $name);
        }
    }
}
namespace app\dao\order {
    // Only collect the actual legacy method's computed update; never connect.
    class StoreOrderDao {
        public array $updates = [];
        public function update($id, $values, $key) {
            if ($key !== 'id') throw new \RuntimeException('Unexpected DAO call');
            $this->updates[$id] = $values;
            return 1;
        }
    }
}
namespace {
    if (!extension_loaded('bcmath')) throw new \RuntimeException('BCMath required');
    $source = dirname(__DIR__, 3) . '/cinashop-php/app/services/order/StoreOrderSplitServices.php';
    require $source;
    $service = (new \ReflectionClass(\app\services\order\StoreOrderSplitServices::class))
        ->newInstanceWithoutConstructor();
    $cases = json_decode(file_get_contents(__DIR__ . '/../test/fixtures/refund-split-bcmath.json'), true, 32, JSON_THROW_ON_ERROR);
    $moneyFields = ['coupon_price', 'integral_price', 'postage_price', 'one_brokerage', 'two_brokerage',
        'sum_true_price', 'first_order_price', 'division_staff_brokerage', 'division_agent_brokerage', 'division_brokerage'];
    $checks = 0;
    foreach ($cases as $case) {
        foreach ($case['scale'] === 0 ? ['use_integral'] : $moneyFields as $field) {
            $snapshot = ['cart_num' => $case['quantity'], $field => $case['total']];
            $selected = $service->slpitComputeOrderCart($case['selectedQuantity'], $snapshot);
            $remaining = $service->slpitComputeOrderCart($case['quantity'] - $case['selectedQuantity'], $snapshot, 1);
            if (bcadd((string)$selected[$field], '0', $case['scale']) !== $case['selected']
                || bcadd((string)$remaining[$field], '0', $case['scale']) !== $case['remaining']) {
                throw new \RuntimeException('BCMath contract mismatch: ' . $case['name'] . ' / ' . $field);
            }
            $checks++;
        }
    }
    $paymentCases = json_decode(file_get_contents(__DIR__ . '/../test/fixtures/refund-split-payment.json'), true, 32, JSON_THROW_ON_ERROR);
    $dao = new \app\dao\order\StoreOrderDao();
    (new \ReflectionProperty($service, 'dao'))->setValue($service, $dao);
    $zeroSelectedDifferences = 0;
    foreach ($paymentCases as $case) {
        $cart = fn($raw) => [['cart_id' => '501', 'cart_num' => 1,
            'cart_info' => json_encode(['sum_true_price' => $raw], JSON_THROW_ON_ERROR)]];
        $order = ['shipping_type' => 1, 'status' => 0];
        $service->splitComputeOrder(1, $cart($case['selectedRaw']), $order, (float)$case['raw'], (float)$case['actual']);
        $service->splitComputeOrder(2, $cart(bcsub($case['raw'], $case['selectedRaw'], 2)), $order,
            (float)$case['raw'], (float)$case['actual'], (float)$dao->updates[1]['pay_price']);
        if (bcadd((string)$dao->updates[1]['pay_price'], '0', 2) !== $case['selected']
            || bcadd((string)$dao->updates[2]['pay_price'], '0', 2) !== $case['legacyRemaining']) {
            throw new \RuntimeException('Actual splitComputeOrder contract mismatch for ' . $case['actual'] . '/' . $case['raw']);
        }
        if ($case['remaining'] !== $case['legacyRemaining']) {
            if ($case['selected'] !== '0.00' || bcadd($case['selected'], $case['remaining'], 2) !== $case['actual']) {
                throw new \RuntimeException('Unexpected claimed legacy divergence');
            }
            $zeroSelectedDifferences++;
        }
    }
    echo json_encode(['phpVersion' => PHP_VERSION, 'sourceSha256' => hash_file('sha256', $source),
        'casesPassed' => count($cases), 'fieldPairsPassed' => $checks,
        'paymentCasesPassed' => count($paymentCases), 'zeroSelectedRemainderDefectsReproduced' => $zeroSelectedDifferences,
        'frameworkBooted' => false, 'databaseAccess' => false], JSON_THROW_ON_ERROR), PHP_EOL;
}
