local function makeCounter(start)
    local value = start
    return function(step)
        value = value + (step or 1)
        return value
    end
end

local counter = makeCounter(10)
local results = {}
for i = 1, 4 do
    results[i] = counter(i)
end
print("PRIVATE_COUNTER_RESULT", table.concat(results, ", "))
return results
