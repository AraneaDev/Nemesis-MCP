<?php

namespace Experiments\PartialMock\Tests;

use Experiments\PartialMock\Ledger;
use Mockery;
use PHPUnit\Framework\TestCase;

class LedgerTest extends TestCase
{
    public function testPartialMocksNameMembersThatHaveToExist(): void
    {
        // PHPUnit refuses to configure a method the class does not declare,
        // and `reconcile` moved out of this class.
        $phpunit = $this->createPartialMock(Ledger::class, ['post', 'reconcile']);

        // Mockery says the same thing inside the class string.
        $mockery = Mockery::mock('Experiments\PartialMock\Ledger[post,reconcile]');

        $this->assertNotNull($phpunit);
        $this->assertNotNull($mockery);
    }
}
