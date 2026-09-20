<?php
// Read-only oracle: invoke the actual legacy methods without framework boot,
// constructors, autoloading, application configuration, database or network I/O.
namespace app\services {
    class BaseServices {
        public function __call($name, $arguments) {
            throw new \RuntimeException('Unexpected framework call: ' . $name);
        }
    }
}
namespace {
    if (!extension_loaded('bcmath')) throw new \RuntimeException('BCMath required');
    $sourceRoot = dirname(__DIR__, 3) . '/cinashop-php';
    $source = $sourceRoot . '/app/services/product/product/StoreProductServices.php';
    require $sourceRoot . '/crmeb/traits/OptionTrait.php';
    require $source;
    $service = (new \ReflectionClass(\app\services\product\product\StoreProductServices::class))
        ->newInstanceWithoutConstructor();
    $cases = json_decode(file_get_contents(__DIR__ . '/../test/fixtures/member-price-bcmath.json'), true, 32, JSON_THROW_ON_ERROR);
    $passed = 0;
    foreach ($cases as $index => $case) {
        $quote = $service->getMinPrice(0, ['price' => $case['price'], 'is_vip' => $case['isVip'],
            'vip_price' => $case['vipPrice']], $case['discount']);
        // Explicit non-empty account and string discount avoid all DAO lookups,
        // including setLevelPrice's special integer-zero "load discount" branch.
        $pay = $service->setLevelPrice($case['price'], 1, ['is_money_level' => 1], true,
            $case['discount'], $case['vipPrice'], $case['isVip'], false);
        if (bccomp((string)$quote['level_price'], $case['levelPrice'], 2) !== 0
            || bccomp((string)$quote['vip_price'], $case['selectedPrice'], 2) !== 0
            || $quote['price_type'] !== $case['priceType']
            || bccomp((string)$pay[0], $case['payPrice'], 2) !== 0) {
            throw new \RuntimeException('Oracle mismatch at synthetic case ' . $index . ': '
                . json_encode(['quote' => $quote, 'pay' => $pay], JSON_THROW_ON_ERROR));
        }
        $passed++;
    }
    echo json_encode(['phpVersion' => PHP_VERSION, 'sourceSha256' => hash_file('sha256', $source),
        'casesPassed' => $passed, 'frameworkBooted' => false, 'databaseAccess' => false], JSON_THROW_ON_ERROR), PHP_EOL;
}
