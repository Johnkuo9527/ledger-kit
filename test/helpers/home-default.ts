/// Every test file starts in the kit's first home — SGD, Singapore days — and its
/// first language, Traditional Chinese, so the tests written before the home and
/// the language became choices keep meaning what they meant. A test about another
/// home or language sets its own (setHome, setLanguage) and puts this one back.
import { setHome, SINGAPORE } from "../../src/home";
import { setLanguage } from "../../src/words";

setHome(SINGAPORE);
setLanguage("zh-Hant");
