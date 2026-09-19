<?php

namespace Experiments\Pest;

final class FeatureFlag
{
    public function enabled(string $name): bool
    {
        return $name !== '';
    }
}
