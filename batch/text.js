export function normalizeShortAnswerForQuestion(questionText, answerText, answerSize) {
    const question = String(questionText || '');
    let answer = String(answerText || '').replace(/\s+/g, ' ').trim();
    const asksYesNo = /(?:^|\s)ли(?:\s|[?.,:])/iu.test(question);

    if (asksYesNo) {
        if (/^(?:нет|не\s+\p{L}+|запрещено)(?:$|[^\p{L}])/iu.test(answer)) {
            return 'нет';
        }
        if (/^(?:да|вправе|может|должен|обязан|допускается|разрешается|следует|имеет\s+право)(?:$|[^\p{L}])/iu.test(answer)) {
            return 'да';
        }
    }

    if (/от\s*(?:\.{2,}|…+)\s*до\s*(?:\.{2,}|…+)/iu.test(question)) {
        const numbers = answer.match(/\d+(?:[.,]\d+)?/gu);
        if (numbers?.length >= 2) return `${numbers[0]} до ${numbers[1]}`;
    }

    const blanks = [...question.matchAll(/\.{2,}|…+/gu)];
    if (blanks.length === 1) {
        const suffix = question
            .slice(blanks[0].index + blanks[0][0].length)
            .match(/^\s*([\p{L}-]+(?:\s+[\p{L}-]+){0,2})/u)?.[1];
        const words = suffix?.split(/\s+/u) || [];
        for (let length = words.length; length > 0; length -= 1) {
            const repeated = words.slice(0, length).join(' ');
            if (
                answer.length > repeated.length &&
                answer.toLocaleLowerCase('ru-RU').endsWith(
                    repeated.toLocaleLowerCase('ru-RU')
                )
            ) {
                answer = answer.slice(0, -repeated.length).trim();
                break;
            }
        }
    }

    if (blanks.length) {
        const genitiveOne = answer.match(/^1\s+(года|месяца|дня|часа)$/iu);
        if (genitiveOne) return `одного ${genitiveOne[1]}`;
    }

    const person = answer.match(/^\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+(?:вич|вна|ич|ична)\s+(\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?)$/u);
    const asksFullName = /Ф\.?\s*И\.?\s*О\.?|полн\p{L}*\s+имя|имя.{0,20}отчество|фамили\p{L}*.{0,15}имя/iu.test(question);
    if (blanks.length === 1 && person && !asksFullName && Number.isInteger(answerSize)
        && answerSize > 0 && answer.length > answerSize && person[1].length <= answerSize) return person[1];

    return answer;
}
