export const SAMPLE_HTML = `
<h1>
  Software metrics assignment
</h1>
<h2>
  Question 1
</h2>
<p>
  Total LOC = 55,200
  <br>
  Average productivity = 700 (LOC/pm)
  <br>
  Average labor rate = $6500$ per month
</p>
<p>
  Calculate the total effort and cost required to complete the above project.
</p>
<p>
  Total effort = Total LOC / productivity = 55200 / 700 = 78.857 = 79 person-month
  <br>
  Total cost = Total effort * cost of person-month = 78.857 * $6500 = $512,570
</p>
<h2>
  Question 2
</h2>
<pre>
  1 /***
2 ** Sum numbers in a vector.
3 *
4 ** This sum is the arithmetic sum, not some other kind of sum that only
5 ** mathematicians have heard of.
6 **
7 ** @param values Container whose values are summed.
8 ** @return sum of 'values', or 0.0 if 'values' is empty.
9 */
10 int SumVector(vector&lt;int&gt; values){ 1
    int counter = 0 // just a counter 2
    // loop in the vector
    for(auto v : values) 3
    {
        d
            counter += v; 5
        }
    return counter; 7
}
</pre>
<p>
  Answer: B (8 LOC) (comments are not counted)
</p>
<!-- page break -->
  <h3>
    Question 3
  </h3>
  <p>
    <b>
      User Inputs = 2 EI
    </b>
  </p>
  <p>
    <b>
      User Outputs = 3 EO
    </b>
  </p>
  <p>
    <b>
      User Queries = 2 EQ
    </b>
  </p>
  <p>
    <b>
      Internal Logical File = 1 ILF
    </b>
  </p>
  <p>
    <b>
      External Interface Files = 3 EIF
    </b>
  </p>
  <p>
    All weighting factors are average
  </p>
  <p>
    All technical complexity factors are average
  </p>
  <p>
    <math>
      \\text{UFP} = (2 \\times 4) + (3 \\times 5) + (2 \\times 4) + (1 \\times 10) + (3 \\times 7) = 62
    </math>
  </p>
  <p>
    All 14 factors are average, so each = 3:
  </p>
  <p>
    <math>
      \\text{DI} = 14 \\times 4 = 42
    </math>
  </p>
  <p>
    <math>
      \\text{TCF} = 0.65 + 0.01 \\times \\text{DI} = 0.65 + 0.01 \\times 42 = 1.07
    </math>
  </p>
  <p>
    <math display="block">
      \\begin{aligned}\\text{FP} &amp;= \\text{UFP} \\times \\text{TCF} \\\\ \\text{FP} &amp;= 62 \\times 1.07 = 66.34\\end{aligned}
    </math>
  </p>
  <p>
    Using SQL =
    <math>
      21 \\text{ LOC}/\\text{FP}
    </math>
    :
  </p>
  <p>
    <math display="block">
      \\begin{aligned}\\text{LOC} &amp;= 66.34 \\times 21 = 1393.14\\end{aligned}
    </math>
  </p>
  <p>
    <b>
      FP = 66.34
    </b>
  </p>
  <p>
    <b>
      LOC = 1393
    </b>
  </p>
  <!-- page break -->
    <h2>
      Question 4
    </h2>
    <p>
      12 complex external outputs
      <br>
      8 average external inputs
      <br>
      15 complex external interface files
      <br>
      7 simple internal logical files
      <br>
      5 average external inquiries
      <br>
      TCF = 1.10
    </p>
    <p>
      EQ complex = 7
      <br>
      EI average = 4
      <br>
      EIF complex = 10
      <br>
      ILF simple = 7
      <br>
      EQ average = 4
    </p>
    <p>
      <math>
        \\text{UFP} = (12 \\times 7) + (8 \\times 4) + (15 \\times 10) + (7 \\times 7) + (5 \\times 4) = 335
      </math>
      <br>
      <math>
        \\text{FP} = \\text{UFP} \\times \\text{TCF} = 335 \\times 1.10 = 368.5
      </math>
    </p>
    <p>
      Using Visual Basic =
      <math>
        42 \\text{ LOC}/\\text{FP}
      </math>
      :
      <br>
      <math>
        \\text{LOC} = 368.5 \\times 42 = 15477
      </math>
    </p>
    <p>
      <b>
        FP = 368.5
      </b>
      <br>
      <b>
        LOC = 15,477
      </b>
    </p>
    <!-- page break -->
      <h2>
        Question 5
      </h2>
      <p>
        EI: Simple = 3, Average = 4, Complex = 6
        <br>
        EI total = (2 * 4) + (1 * 3) + (3 * 6) = 29
      </p>
      <p>
        EO: Simple = 4, Average = 5, Complex = 7
        <br>
        EO total = (1 * 7) + (2 * 5) + (5 * 4) = 37
      </p>
      <p>
        EQ: Simple = 3, Average = 4, Complex = 6
        <br>
        EQ total = (6 * 3) + (3 * 4) + (10 * 6) = 90
      </p>
      <p>
        ILF: Average = 10
        <br>
        ILF total = (2 * 10) = 20
      </p>
      <p>
        EIF: Average = 7, Complex = 10
        <br>
        EIF total = (2 * 7) + (3 * 10) = 44
      </p>
      <p>
        UFP = 29 + 37 + 90 + 20 + 44 = 220
      </p>
      <hr>
      <p>
        DI = Data communication + Performance + Reusability + Multiple installation + Other 10 average factors
        <br>
        DI = 4 + 5 + 3 + 0 + (10 * 3) = 42
      </p>
      <p>
        TCF =
        <math>
          0.65 + (0.01 \\times DI)
        </math>
        = 1.07
      </p>
      <p>
        FP = UFP * TCF =
        <math>
          220 \\times 1.07
        </math>
        = 235.4
      </p>
      <p>
        Using C++:
        <br>
        LOF = FP * 50
        <br>
        LOF =
        <math>
          235.4 \\times 50
        </math>
        <br>
        LOC = 11770
      </p>
      <p>
        Final Answer:
      </p>
      <p>
        Function Points (FP) = 235.4
        <br>
        Lines of Code (LOC) = 11,770
      </p>
`;
